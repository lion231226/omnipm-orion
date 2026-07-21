/**
 * OmniPM Orion Extension — 多专家并行执行引擎
 * 
 * 为 PI Agent 注册 OmniPM 专属工具：
 * - run_experts: 单/并行调度专家子代理（独立 pi 进程）
 * - omni_dag: DAG 执行状态管理（检查点/恢复/熔断）
 * 
 * OmniPM 设计哲学：Orion 是前台主 Agent，对最终交付负责；
 * 专家是后台子代理，提供专业输入。本 Extension 实现这套架构。
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

// ============================================================
// 常量
// ============================================================

const MAX_PARALLEL_EXPERTS = 8;
const MAX_CONCURRENCY = 4;
const PER_EXPERT_OUTPUT_CAP = 50 * 1024;
const MAX_CORRECTIONS_PER_NODE = 3;

// ============================================================
// DAG 状态管理
// ============================================================

interface DAGNodeState {
	nodeId: string;
	name: string;
	status: "pending" | "running" | "done" | "failed" | "blocked";
	correctionCount: number;
	startedAt?: string;
	completedAt?: string;
}

interface DAGState {
	projectName: string;
	nodes: DAGNodeState[];
	currentNode?: string;
	createdAt: string;
	updatedAt: string;
}

function getDAGStatePath(cwd: string): string {
	return path.join(cwd, ".pi", "omnipm_dag_state.json");
}

function loadDAGState(cwd: string): DAGState | null {
	const p = getDAGStatePath(cwd);
	try {
		return JSON.parse(fs.readFileSync(p, "utf-8"));
	} catch {
		return null;
	}
}

function saveDAGState(cwd: string, state: DAGState): void {
	const p = getDAGStatePath(cwd);
	const dir = path.dirname(p);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	state.updatedAt = new Date().toISOString();
	fs.writeFileSync(p, JSON.stringify(state, null, 2), "utf-8");
}

// ============================================================
// 工具函数
// ============================================================

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

interface UsageStats {
	input: number; output: number; cacheRead: number; cacheWrite: number;
	cost: number; contextTokens: number; turns: number;
}

function formatUsage(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns}t`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

interface ExpertResult {
	expert: string;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	severity?: "P0" | "P1" | "P2";
}

function parseSeverity(output: string): "P0" | "P1" | "P2" | undefined {
	const p0 = output.match(/P0[-\s]*阻塞/i) || output.match(/严重等级[：:]\s*P0/i);
	if (p0) return "P0";
	const p1 = output.match(/P1[-\s]*重要/i) || output.match(/严重等级[：:]\s*P1/i);
	if (p1) return "P1";
	const p2 = output.match(/P2[-\s]*建议/i) || output.match(/严重等级[：:]\s*P2/i);
	if (p2) return "P2";
	return undefined;
}

async function writeTempFile(name: string, content: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omnipm-"));
	const safeName = name.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

async function mapConcurrency<T>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<T>): Promise<T[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: T[] = new Array(items.length);
	let next = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return results;
}

// ============================================================
// 专家子代理执行器
// ============================================================

async function runExpert(
	defaultCwd: string,
	agent: AgentConfig,
	task: string,
	signal: AbortSignal | undefined,
): Promise<ExpertResult> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

	const result: ExpertResult = {
		expert: agent.name,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
	};

	let tmpDir: string | null = null;
	let tmpPath: string | null = null;
	let wasAborted = false;

	try {
		// 写入专家系统提示词到临时文件
		const tmp = await writeTempFile(agent.name, agent.systemPrompt);
		tmpDir = tmp.dir;
		tmpPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPath);

		// 附加任务描述
		args.push(`Task: ${task}`);

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					let event: any;
					try { event = JSON.parse(line); } catch { continue; }

					if (event.type === "message_end" && event.message) {
						const msg = event.message as Message;
						result.messages.push(msg);
						if (msg.role === "assistant") {
							result.usage.turns++;
							const u = msg.usage;
							if (u) {
								result.usage.input += u.input || 0;
								result.usage.output += u.output || 0;
								result.usage.cacheRead += u.cacheRead || 0;
								result.usage.cacheWrite += u.cacheWrite || 0;
								result.usage.cost += u.cost?.total || 0;
								result.usage.contextTokens = u.totalTokens || 0;
							}
							if (!result.model && msg.model) result.model = msg.model;
							if (msg.stopReason) result.stopReason = msg.stopReason;
						}
					}
				}
			});

			proc.stderr.on("data", (data: Buffer) => { result.stderr += data.toString(); });

			proc.on("close", (code) => {
				if (buffer.trim()) {
					try { const evt = JSON.parse(buffer.trim()); if (evt.type === "message_end" && evt.message) result.messages.push(evt.message); } 
					catch { /* ignore */ }
				}
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			if (signal) {
				const kill = () => { wasAborted = true; proc.kill("SIGTERM"); setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000); };
				if (signal.aborted) kill();
				else signal.addEventListener("abort", kill, { once: true });
			}
		});

		result.exitCode = exitCode;
		if (wasAborted) throw new Error("Expert subagent was aborted");
		return result;
	} finally {
		if (tmpPath) try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
		if (tmpDir) try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
	}
}

// ============================================================
// 参数 Schema
// ============================================================

const ExpertTask = Type.Object({
	expert: Type.String({ description: "专家名称 (architect/security/backend/frontend/database/qa/devops/requirements/course-designer/content-reviewer/market-analyst/seo-expert/media-producer)" }),
	task: Type.String({ description: "委派给专家的具体任务描述" }),
	context: Type.Optional(Type.String({ description: "评审所需的上下文材料（设计文档/代码等）" })),
});

const ExpertIntensity = StringEnum(["LIGHT", "STANDARD", "DEEP", "PAIR"] as const, {
	description: "专家调用强度: LIGHT=快速扫描, STANDARD=标准评审, DEEP=深度审查, PAIR=双人结对",
	default: "STANDARD",
});

const RunExpertsParams = Type.Object({
	experts: Type.Array(ExpertTask, { description: "要调度的专家和任务列表。单专家传入1个，多专家并行传入2-8个" }),
	intensity: Type.Optional(ExpertIntensity),
	agentScope: Type.Optional(StringEnum(["omnipm", "user", "both"] as const, { default: "omnipm" })),
});

const OmniDAGParams = Type.Object({
	action: StringEnum(["init", "start", "complete", "fail", "status", "reset"] as const, {
		description: "init=初始化DAG, start=开始节点, complete=完成节点, fail=节点失败, status=查看状态, reset=重置",
	}),
	projectName: Type.Optional(Type.String({ description: "项目名称（init时必填）" })),
	nodes: Type.Optional(Type.Array(Type.Object({
		id: Type.String(),
		name: Type.String(),
		dependsOn: Type.Optional(Type.Array(Type.String())),
	}), { description: "DAG节点定义（init时必填）" })),
	nodeId: Type.Optional(Type.String({ description: "节点ID（start/complete/fail时必填）" })),
	failReason: Type.Optional(Type.String({ description: "失败原因（fail时填写）" })),
});

// ============================================================
// Extension 入口
// ============================================================

export default function (pi: ExtensionAPI) {
	
	// --------------------------------------------------
	// 工具 1: run_experts — 单/并行专家评审
	// --------------------------------------------------
	pi.registerTool({
		name: "run_experts",
		label: "Run Experts",
		description: [
			"调度 OmniPM 专家子代理进行独立/并行评审。",
			"每位专家在独立 pi 进程中运行，拥有隔离的上下文窗口。",
			"支持 13 位 OmniPM 内置专家：",
			"architect(系统架构师), security(安全专家), backend(后端专家), frontend(前端专家),",
			"database(数据库专家), qa(测试架构师), devops(DevOps), requirements(需求分析师),",
			"course-designer(教学设计), content-reviewer(内容审核), market-analyst(市场分析),",
			"seo-expert(SEO), media-producer(媒体制作)",
			"单专家评审传1个 task，多专家并行传2-8个 tasks（最多4个并发）。",
			"专家输出包含严重等级(P0/P1/P2)，Orion 据此综合决议。",
		].join(" "),
		parameters: RunExpertsParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const scope: AgentScope = params.agentScope ?? "omnipm";
			const discovery = discoverAgents(ctx.cwd, scope);
			const agents = discovery.agents;
			const intensity = params.intensity ?? "STANDARD";

			if (!params.experts || params.experts.length === 0) {
				const available = agents.map(a => `"${a.name}"`).join(", ") || "none";
				return {
					content: [{ type: "text", text: `No experts specified. Available: ${available}` }],
					details: { mode: "single", results: [] },
				};
			}

			if (params.experts.length > MAX_PARALLEL_EXPERTS) {
				return {
					content: [{ type: "text", text: `Too many experts (${params.experts.length}). Max: ${MAX_PARALLEL_EXPERTS}` }],
					details: { mode: "parallel", results: [] },
				};
			}

			// 强度提示词追加
			const intensityHints: Record<string, string> = {
				LIGHT: "\n\n## 调用强度: LIGHT\n快速扫描，输出 2-3 条核心建议即可。不需要展开详细分析。",
				STANDARD: "\n\n## 调用强度: STANDARD\n标准评审，输出至少 3 条建议，标注严重等级 P0/P1/P2。",
				DEEP: "\n\n## 调用强度: DEEP\n深度审查，逐项检查，输出至少 5 条建议，标注严重等级。对每个建议给出具体修正方案。",
				PAIR: "\n\n## 调用强度: PAIR\n结对评审模式。你需要关注与其他专家的交叉领域，在输出中标注需要联合讨论的议题。",
			};

			// 单专家模式
			if (params.experts.length === 1) {
				const et = params.experts[0];
				const agent = agents.find(a => a.name === et.expert);
				if (!agent) {
					const available = agents.map(a => `"${a.name}"`).join(", ");
					return {
						content: [{ type: "text", text: `Unknown expert: "${et.expert}". Available: ${available}` }],
						details: { mode: "single", results: [] },
					};
				}

				const fullTask = et.context
					? `${et.task}\n\n## 评审材料\n\n${et.context}\n${intensityHints[intensity]}`
					: `${et.task}${intensityHints[intensity]}`;

				const result = await runExpert(ctx.cwd, agent, fullTask, signal);
				const output = getFinalOutput(result.messages);
				const sev = parseSeverity(output);

				return {
					content: [{
						type: "text",
						text: `## ${agent.name} 评审意见\n\n${output || "(no output)"}\n\n---\n*严重等级: ${sev || "未标注"} | ${formatUsage(result.usage, result.model)}*`,
					}],
					details: { mode: "single", results: [{ ...result, severity: sev }] },
				};
			}

			// 并行模式
			const allResults: ExpertResult[] = [];
			
			const results = await mapConcurrency(params.experts, MAX_CONCURRENCY, async (et) => {
				const agent = agents.find(a => a.name === et.expert);
				if (!agent) {
					return {
						expert: et.expert, task: et.task, exitCode: 1, messages: [],
						stderr: `Unknown expert: "${et.expert}"`,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const fullTask = et.context
					? `${et.task}\n\n## 评审材料\n\n${et.context}\n${intensityHints[intensity]}`
					: `${et.task}${intensityHints[intensity]}`;

				return await runExpert(ctx.cwd, agent, fullTask, signal);
			});

			allResults.push(...results);

			const successCount = results.filter(r => r.exitCode === 0).length;
			const summaries = results.map(r => {
				const output = getFinalOutput(r.messages);
				const sev = parseSeverity(output);
				const status = r.exitCode !== 0 ? "❌ 失败" : "✅ 完成";
				const capped = output.length > PER_EXPERT_OUTPUT_CAP
					? output.slice(0, PER_EXPERT_OUTPUT_CAP) + "\n\n[输出已截断]"
					: output;
				return `### ${r.expert} ${status}\n\n${capped}\n\n*严重等级: ${sev || "未标注"} | ${formatUsage(r.usage, r.model)}*`;
			});

			return {
				content: [{
					type: "text",
					text: `## 并行专家评审: ${successCount}/${results.length} 完成\n\n${summaries.join("\n\n---\n\n")}`,
				}],
				details: { mode: "parallel", results: allResults.map(r => ({ ...r, severity: parseSeverity(getFinalOutput(r.messages)) })) },
			};
		},

		renderCall(args, theme, _context) {
			const count = args.experts?.length || 0;
			const names = args.experts?.map((e: any) => e.expert).join(", ") || "...";
			const label = count > 1 ? `parallel (${count})` : "single";
			let text =
				theme.fg("toolTitle", theme.bold("run_experts ")) +
				theme.fg("accent", label);
			if (names.length < 80) text += `\n  ${theme.fg("dim", names)}`;
			else text += `\n  ${theme.fg("dim", names.slice(0, 80) + "...")}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as any;
			const text = result.content?.[0];
			const content = text?.type === "text" ? text.text : "(no output)";
			
			if (expanded) {
				const mdTheme = getMarkdownTheme();
				const container = new Container();
				container.addChild(new Markdown(content, 0, 0, mdTheme));
				return container;
			}
			
			const lines = content.split("\n");
			const preview = lines.slice(0, 20).join("\n");
			if (lines.length > 20) {
				return new Text(preview + `\n${theme.fg("muted", "...(Ctrl+O to expand)")}`, 0, 0);
			}
			return new Text(content, 0, 0);
		},
	});

	// --------------------------------------------------
	// 工具 2: omni_dag — DAG 状态管理
	// --------------------------------------------------
	const dagStates = new Map<string, DAGState>();

	pi.registerTool({
		name: "omni_dag",
		label: "OmniPM DAG",
		description: [
			"管理 OmniPM v2.0.0 动态 DAG 的执行状态。",
			"init: 创建新的 DAG，传入 projectName + nodes 定义。",
			"start: 标记节点为运行中。自动检查前置依赖是否满足。",
			"complete: 标记节点完成，解锁后续节点。",
			"fail: 标记节点失败。自动检查熔断计数（同一节点失败3次 → blocked）。",
			"status: 查看 DAG 当前状态（已完成/运行中/待执行/阻塞的节点）。",
			"reset: 重置 DAG 状态。",
		].join(" "),
		parameters: OmniDAGParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			let state = dagStates.get(cwd);

			switch (params.action) {
				case "init": {
					if (!params.projectName || !params.nodes) {
						return { content: [{ type: "text", text: "init requires projectName and nodes" }] };
					}
					state = {
						projectName: params.projectName,
						nodes: params.nodes.map(n => ({
							nodeId: n.id,
							name: n.name,
							status: "pending" as const,
							correctionCount: 0,
						})),
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					};
					dagStates.set(cwd, state);
					saveDAGState(cwd, state);
					return {
						content: [{
							type: "text",
							text: `## DAG 已初始化: ${params.projectName}\n\n节点: ${params.nodes.length} 个\n${params.nodes.map(n => `- [ ] ${n.id}: ${n.name}`).join("\n")}`,
						}],
					};
				}

				case "start": {
					if (!state) return { content: [{ type: "text", text: "No DAG. Use 'init' first." }] };
					if (!params.nodeId) return { content: [{ type: "text", text: "nodeId required" }] };
					
					const node = state.nodes.find(n => n.nodeId === params.nodeId);
					if (!node) return { content: [{ type: "text", text: `Node "${params.nodeId}" not found` }] };
					if (node.status === "blocked") return {
						content: [{ type: "text", text: `⚠️ 节点 "${params.nodeId}" 已熔断（3次修正失败）。请用户介入处理。` }],
					};
					
					node.status = "running";
					node.startedAt = new Date().toISOString();
					state.currentNode = params.nodeId;
					state.updatedAt = new Date().toISOString();
					saveDAGState(cwd, state);
					
					return { content: [{ type: "text", text: `▶ 开始节点: ${node.name} (${node.nodeId})` }] };
				}

				case "complete": {
					if (!state) return { content: [{ type: "text", text: "No DAG. Use 'init' first." }] };
					if (!params.nodeId) return { content: [{ type: "text", text: "nodeId required" }] };
					
					const node = state.nodes.find(n => n.nodeId === params.nodeId);
					if (!node) return { content: [{ type: "text", text: `Node "${params.nodeId}" not found` }] };
					
					node.status = "done";
					node.completedAt = new Date().toISOString();
					node.correctionCount = 0; // 成功后重置计数
					state.updatedAt = new Date().toISOString();
					saveDAGState(cwd, state);
					
					const doneCount = state.nodes.filter(n => n.status === "done").length;
					const total = state.nodes.length;
					
					return {
						content: [{
							type: "text",
							text: `✅ 完成节点: ${node.name}\n\n进度: ${doneCount}/${total} (${Math.round(doneCount/total*100)}%)`,
						}],
					};
				}

				case "fail": {
					if (!state) return { content: [{ type: "text", text: "No DAG. Use 'init' first." }] };
					if (!params.nodeId) return { content: [{ type: "text", text: "nodeId required" }] };
					
					const node = state.nodes.find(n => n.nodeId === params.nodeId);
					if (!node) return { content: [{ type: "text", text: `Node "${params.nodeId}" not found` }] };
					
					node.correctionCount++;
					
					if (node.correctionCount >= MAX_CORRECTIONS_PER_NODE) {
						node.status = "blocked";
						state.updatedAt = new Date().toISOString();
						saveDAGState(cwd, state);
						return {
							content: [{
								type: "text",
								text: `🚨 熔断！节点 "${node.name}" 已失败 ${node.correctionCount} 次（上限 ${MAX_CORRECTIONS_PER_NODE}）。\n\n建议: (A) 人工介入 (B) 回退上级节点 (C) 标记为已知限制跳过\n原因: ${params.failReason || "未指定"}`,
							}],
						};
					}
					
					node.status = "failed";
					state.updatedAt = new Date().toISOString();
					saveDAGState(cwd, state);
					
					return {
						content: [{
							type: "text",
							text: `❌ 节点失败: ${node.name} (第 ${node.correctionCount}/${MAX_CORRECTIONS_PER_NODE} 次)\n原因: ${params.failReason || "未指定"}\n\n将自动尝试修正...`,
						}],
					};
				}

				case "status": {
					if (!state) return { content: [{ type: "text", text: "No active DAG. Use 'init' to create one." }] };
					
					const done = state.nodes.filter(n => n.status === "done").length;
					const running = state.nodes.filter(n => n.status === "running").length;
					const failed = state.nodes.filter(n => n.status === "failed").length;
					const blocked = state.nodes.filter(n => n.status === "blocked").length;
					const pending = state.nodes.filter(n => n.status === "pending").length;
					
					const statusLines = state.nodes.map(n => {
						const icon = { done: "✅", running: "⏳", failed: "❌", blocked: "🚨", pending: "⬜" }[n.status];
						const corr = n.correctionCount > 0 ? ` [修正:${n.correctionCount}]` : "";
						return `${icon} ${n.nodeId}: ${n.name} [${n.status}]${corr}`;
					}).join("\n");
					
					return {
						content: [{
							type: "text",
							text: `## DAG 状态: ${state.projectName}\n\n` +
								`完成:${done} | 运行:${running} | 失败:${failed} | 阻塞:${blocked} | 待执行:${pending}\n\n` +
								statusLines +
								`\n\n当前节点: ${state.currentNode || "无"}`
						}],
					};
				}

				case "reset": {
					dagStates.delete(cwd);
					try { fs.unlinkSync(getDAGStatePath(cwd)); } catch { /* ignore */ }
					return { content: [{ type: "text", text: "DAG 状态已重置。" }] };
				}

				default:
					return { content: [{ type: "text", text: `Unknown action: ${params.action}` }] };
			}
		},

		renderCall(args, theme, _context) {
			const action = args.action || "?";
			const detail = args.action === "init" ? ` ${args.projectName || ""}` :
				args.action === "status" ? "" : ` ${args.nodeId || ""}`;
			return new Text(
				theme.fg("toolTitle", theme.bold("omni_dag ")) +
				theme.fg("accent", action) +
				theme.fg("dim", detail),
				0, 0,
			);
		},

		renderResult(result, _expanded, theme, _context) {
			const text = result.content?.[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// --------------------------------------------------
	// Session Hook: 注入 OmniPM 工具清单
	// --------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		const discovery = discoverAgents(ctx.cwd, "omnipm");
		const expertNames = discovery.agents.map(a => a.name).join(", ");
		ctx.ui.notify(
			`OmniPM: ${discovery.agents.length} experts loaded (${expertNames})`,
			"info",
		);
	});

	console.log("OmniPM Orion Extension v2.0.0 loaded. Tools: run_experts, omni_dag");
}
