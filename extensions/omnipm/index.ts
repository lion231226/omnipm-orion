/**
 * OmniPM Orion Extension — 多专家并行/链式执行引擎 (v2.1.0)
 * 
 * 为 PI Agent 注册 OmniPM 专属工具：
 * - run_experts: 单/并行/链式调度专家子代理（独立 pi 进程）
 * - omni_dag: DAG 执行状态管理（检查点/恢复/熔断）
 * 
 * v2.1.0 新增（P1-3 链式调用 + P1-4 DAG_CONTEXT 自动注入）:
 * - Chain Mode: 专家按序执行，{previous} 上下文传递
 * - DAG Context Injection: 自动为子代理注入 DAG 执行状态
 * - Degradation Circuit Breaker: 降级熔断保护
 * - tool_call Hook: 自动刷新 DAG 上下文
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

/** P1-3: 链式调用最大步数 */
const MAX_CHAIN_STEPS = 10;
/** P1-3: 单步最大重试次数 */
const MAX_CHAIN_RETRIES = 3;
/** P1-4: DAG 上下文文件名 */
const DAG_CONTEXT_FILENAME = "omnipm_dag_context.md";
/** P1-4: 降级计数器最大阈值 */
const MAX_DEGRADATION_COUNT = 5;
/** P1-4: 熔断冷却时间（ms） */
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

// ============================================================
// DAG 状态管理（v2.0.0 基础 + v2.1.0 扩展）
// ============================================================

interface DAGNodeState {
	nodeId: string;
	name: string;
	status: "pending" | "running" | "done" | "failed" | "blocked" | "awaiting_gate";
	/** P0-3: 节点类型（GATE 节点需额外确认才能标记完成） */
	nodeType?: "ANALYSIS" | "DESIGN" | "REVIEW" | "DEVELOP" | "TEST" | "DELIVER" | "GATE";
	correctionCount: number;
	startedAt?: string;
	completedAt?: string;
	/** P0-1: 节点产出的文件清单（omni_dag complete 时写入并验证） */
	outputs?: {
		files: string[];
		keyDecisions?: string[];
		artifacts?: string[];
	};
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

/** P1-4: DAG 上下文 Markdown 文件路径 */
function getDAGMarkdownPath(cwd: string): string {
	return path.join(cwd, ".pi", DAG_CONTEXT_FILENAME);
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
// P1-4: DAG 上下文构建（DAG_CONTEXT 自动注入）
// ============================================================

/** P1-4: DAG 上下文结构 */
interface DAGContext {
	projectName: string;
	currentNode?: string;
	nodeStatus: string;
	completedNodes: { id: string; name: string }[];
	failedNodes: { id: string; name: string; reason?: string }[];
	blockedNodes: { id: string; name: string }[];
	pendingNodes: { id: string; name: string }[];
	correctionCount: number;
	upstreamSummaries?: Record<string, string>;
	totalNodes: number;
	doneCount: number;
}

/** P1-4: 从 DAG 状态构建上下文对象 */
function buildDAGContext(cwd: string, nodeId?: string): DAGContext | null {
	const state = loadDAGState(cwd);
	if (!state) return null;

	const completedNodes = state.nodes
		.filter(n => n.status === "done")
		.map(n => ({ id: n.nodeId, name: n.name }));
	const failedNodes = state.nodes
		.filter(n => n.status === "failed")
		.map(n => ({ id: n.nodeId, name: n.name }));
	const blockedNodes = state.nodes
		.filter(n => n.status === "blocked")
		.map(n => ({ id: n.nodeId, name: n.name }));
	const pendingNodes = state.nodes
		.filter(n => n.status === "pending")
		.map(n => ({ id: n.nodeId, name: n.name }));

	const currentNode = nodeId ?? state.currentNode;
	const currentStatus = currentNode
		? (state.nodes.find(n => n.nodeId === currentNode)?.status ?? "unknown")
		: "no_active_node";

	let correctionCount = 0;
	for (const n of state.nodes) correctionCount += n.correctionCount;

	return {
		projectName: state.projectName,
		currentNode,
		nodeStatus: currentStatus,
		completedNodes,
		failedNodes,
		blockedNodes,
		pendingNodes,
		correctionCount,
		totalNodes: state.nodes.length,
		doneCount: completedNodes.length,
	};
}

/** P1-4: 构建 DAG 上下文 Markdown 字符串 */
function buildDAGMarkdown(context: DAGContext): string {
	const lines: string[] = [
		`# DAG Execution Context`,
		``,
		`> This context is auto-injected by the OmniPM Extension (P1-4).`,
		`> It provides the expert with current DAG execution status.`,
		``,
		`## Project: ${context.projectName}`,
		``,
		`| Metric | Value |`,
		`|--------|-------|`,
		`| Total Nodes | ${context.totalNodes} |`,
		`| Completed | ${context.doneCount} / ${context.totalNodes} |`,
		`| Progress | ${context.totalNodes > 0 ? Math.round(context.doneCount / context.totalNodes * 100) : 0}% |`,
		`| Current Node | ${context.currentNode ?? "N/A"} (${context.nodeStatus}) |`,
		`| Total Corrections | ${context.correctionCount} |`,
		``,
	];

	if (context.completedNodes.length > 0) {
		lines.push(`## ✅ Completed Nodes`);
		for (const n of context.completedNodes) {
			lines.push(`- ${n.id}: ${n.name}`);
		}
		lines.push(``);
	}

	if (context.failedNodes.length > 0) {
		lines.push(`## ❌ Failed Nodes`);
		for (const n of context.failedNodes) {
			lines.push(`- ${n.id}: ${n.name}`);
		}
		lines.push(``);
	}

	if (context.blockedNodes.length > 0) {
		lines.push(`## 🚨 Blocked Nodes (Circuit Broken)`);
		for (const n of context.blockedNodes) {
			lines.push(`- ${n.id}: ${n.name}`);
		}
		lines.push(``);
	}

	if (context.pendingNodes.length > 0) {
		lines.push(`## ⬜ Pending Nodes`);
		for (const n of context.pendingNodes) {
			lines.push(`- ${n.id}: ${n.name}`);
		}
		lines.push(``);
	}

	if (context.upstreamSummaries && Object.keys(context.upstreamSummaries).length > 0) {
		lines.push(`## 📋 Upstream Summaries`);
		for (const [nodeId, summary] of Object.entries(context.upstreamSummaries)) {
			lines.push(`### ${nodeId}`);
			lines.push(summary);
			lines.push(``);
		}
	}

	lines.push(`---`);
	lines.push(`*Generated at ${new Date().toISOString()} by OmniPM P1-4 Auto-Injection*`);

	return lines.join("\n");
}

/** P1-4: 从已保存的 Markdown 文件构建 DAG 上下文（反向解析） */
function buildDAGContextFromMarkdown(cwd: string): DAGContext | null {
	const p = getDAGMarkdownPath(cwd);
	try {
		const content = fs.readFileSync(p, "utf-8");
		const projectMatch = content.match(/## Project:\s*(.+)/);
		const progressMatch = content.match(/\|\s*Progress\s*\|\s*(\d+)%/);
		const nodeMatch = content.match(/\|\s*Current Node\s*\|\s*([^|]+)/);

		if (!projectMatch) return null;

		const projectName = projectMatch[1].trim();
		const progress = progressMatch ? parseInt(progressMatch[1], 10) : 0;

		const completedSection = content.match(/## ✅ Completed Nodes\n([\s\S]*?)(?=\n##|\n---|$)/);
		const completedNodes: { id: string; name: string }[] = [];
		if (completedSection) {
			const nodeLines = completedSection[1].match(/- (\S+):\s*(.+)/g);
			if (nodeLines) {
				for (const line of nodeLines) {
					const m = line.match(/- (\S+):\s*(.+)/);
					if (m) completedNodes.push({ id: m[1], name: m[2] });
				}
			}
		}

		const failedSection = content.match(/## ❌ Failed Nodes\n([\s\S]*?)(?=\n##|\n---|$)/);
		const failedNodes: { id: string; name: string }[] = [];
		if (failedSection) {
			const nodeLines = failedSection[1].match(/- (\S+):\s*(.+)/g);
			if (nodeLines) {
				for (const line of nodeLines) {
					const m = line.match(/- (\S+):\s*(.+)/);
					if (m) failedNodes.push({ id: m[1], name: m[2] });
				}
			}
		}

		return {
			projectName,
			currentNode: nodeMatch ? nodeMatch[1].trim().split(" ")[0] : undefined,
			nodeStatus: "from_markdown",
			completedNodes,
			failedNodes,
			blockedNodes: [],
			pendingNodes: [],
			correctionCount: 0,
			totalNodes: completedNodes.length + failedNodes.length,
			doneCount: completedNodes.length,
		};
	} catch {
		return null;
	}
}

/** P1-4: 构建最小降级 DAG 上下文（当状态文件不可用时的兜底） */
function buildMinimalDAGContext(): DAGContext {
	return {
		projectName: "Unknown (degraded)",
		currentNode: undefined,
		nodeStatus: "degraded",
		completedNodes: [],
		failedNodes: [],
		blockedNodes: [],
		pendingNodes: [],
		correctionCount: 0,
		totalNodes: 0,
		doneCount: 0,
	};
}

/** P1-4: 保存 DAG 上下文为 Markdown 文件供子代理读取 */
function saveDAGMarkdown(cwd: string, content: string): string {
	const p = getDAGMarkdownPath(cwd);
	const dir = path.dirname(p);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(p, content, "utf-8");
	return p;
}

// ============================================================
// P1-4: 降级状态管理
// ============================================================

let degradationCounter = 0;
let circuitBreakerOpen = false;
let circuitBreakerOpenedAt: number | null = null;

/** P1-4: 尝试重置熔断器（冷却期过后自动恢复） */
function tryResetCircuitBreaker(): boolean {
	if (circuitBreakerOpen && circuitBreakerOpenedAt) {
		const elapsed = Date.now() - circuitBreakerOpenedAt;
		if (elapsed >= CIRCUIT_BREAKER_COOLDOWN_MS) {
			circuitBreakerOpen = false;
			circuitBreakerOpenedAt = null;
			degradationCounter = 0;
			return true;
		}
	}
	return false;
}

/** P1-4: 记录降级事件，达到阈值时打开熔断器 */
function recordDegradation(): boolean {
	degradationCounter++;
	if (degradationCounter >= MAX_DEGRADATION_COUNT && !circuitBreakerOpen) {
		circuitBreakerOpen = true;
		circuitBreakerOpenedAt = Date.now();
		return true;
	}
	return false;
}

/** P1-4: 准备 DAG 上下文文件（含降级处理），返回文件路径或 null */
function prepareDAGContextFile(cwd: string): string | null {
	if (circuitBreakerOpen) {
		if (!tryResetCircuitBreaker()) {
			return null;
		}
	}

	try {
		let context = buildDAGContext(cwd);
		if (!context) {
			context = buildDAGContextFromMarkdown(cwd);
		}
		if (!context) {
			context = buildMinimalDAGContext();
			recordDegradation();
		}

		const markdown = buildDAGMarkdown(context);
		return saveDAGMarkdown(cwd, markdown);
	} catch {
		recordDegradation();
		return null;
	}
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
	claimed_files: string[];
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

// v2.1.1: 输出文件验证
function extractClaimedFiles(output: string): string[] {
	const files = new Set<string>();
	const patterns = [
		/已写入文件[到至]?\s*[：:]*\s*([^\s\n,，;；]+)/g,
		/written\s+(?:file\s+)?to\s*[：:]*\s*([^\s\n,;]+)/gi,
		/`([^`]{1,200}\.[a-zA-Z0-9]{1,10})`/g,
	];
	const blacklist = [/^\/tmp\//, /^https?:\/\//, /^node_modules\//, /^\.pi\//, /^\.git\//];
	for (const pat of patterns) {
		let m: RegExpExecArray | null;
		while ((m = pat.exec(output)) !== null) {
			let fp = m[1].trim().replace(/^['"\(\[]+/, "").replace(/['"\)\]]+$/, "");
			if (fp.length >= 2 && !blacklist.some(b => b.test(fp))) files.add(fp);
		}
	}
	return Array.from(files);
}

function verifyOutputs(cwd: string, claimed: string[]): { missing: string[] } {
	const missing: string[] = [];
	for (const f of claimed) {
		const resolved = path.resolve(cwd, f);
		if (!resolved.startsWith(path.resolve(cwd))) { missing.push(f); continue; }
		try { if (!fs.existsSync(resolved)) missing.push(f); } catch { missing.push(f); }
	}
	return { missing };
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
// ============================================================
// P1-6: DAG 建议机制 & 事件通知层（v2.1.0）
// ============================================================

interface DAGSuggestion {
	action: "complete" | "fail" | "retry" | "blocked";
	nodeId: string;
	reason: string;
	severity?: "P0" | "P1" | "P2";
	correctionCount?: number;
}

function generateDAGSuggestion(
	nodeId: string,
	results: ExpertResult[],
	correctionCount: number,
): DAGSuggestion {
	// v2.1.1: 文件验证优先
	const allClaimed = results.flatMap(r => r.claimed_files || []);
	if (allClaimed.length > 0) {
		const missing = allClaimed.filter(f => { try { return !fs.existsSync(f); } catch { return true; } });
		if (missing.length > 0)
			return { action: "retry", nodeId, reason: `声称写入${missing.length}个文件但不存在`, severity: "P0", correctionCount };
	}
	if (correctionCount >= MAX_CORRECTIONS_PER_NODE) {
		return { action: "blocked", nodeId, reason: `节点已修正 ${correctionCount} 次，达到熔断阈值`, severity: "P0", correctionCount };
	}
	const hasP0 = results.some(r => r.severity === "P0");
	const hasP1 = results.some(r => r.severity === "P1");
	const hasFailure = results.some(r => r.exitCode !== 0);
	if (hasFailure) return { action: "retry", nodeId, reason: "专家执行失败", severity: "P0", correctionCount };
	if (hasP0) return { action: "retry", nodeId, reason: "发现P0阻塞项，需修正后重审", severity: "P0", correctionCount };
	if (hasP1) return { action: "retry", nodeId, reason: "发现P1重要问题，建议修正后重审", severity: "P1", correctionCount };
	return { action: "complete", nodeId, reason: `全部${results.length}位专家通过`, severity: "P2", correctionCount };
}

// P1-3: 链式调用类型定义
// ============================================================

// v2.1.1: DAG_SUGGESTION 可见块格式化
function formatDAGSuggestionBlock(s: DAGSuggestion): string {
	const labels: Record<string, string> = { complete: "PASS", retry: "RETRY", fail: "FAIL", blocked: "BLOCKED" };
	return [
		"╔══════════════════════════════════════════╗",
		"║           DAG_SUGGESTION                  ║",
		"╠══════════════════════════════════════════╣",
		`║  action : ${s.action.padEnd(34)}║`,
		`║  ${labels[s.action] || s.action}${''.padEnd(34 - (labels[s.action]?.length || 0))}║`,
		`║  reason : ${s.reason.slice(0, 32).padEnd(34)}║`,
		`║  nodeId : ${(s.nodeId || 'N/A').padEnd(34)}║`,
		`║  sev    : ${(s.severity || '-').padEnd(34)}║`,
		`║  corrCnt: ${String(s.correctionCount || 0).padEnd(34)}║`,
		"╚══════════════════════════════════════════╝",
	].join("\n");
}

// v2.1.1: 从 DAG 状态读取真实 correctionCount
function getCorrectionCount(cwd: string, nodeId?: string): number {
	if (!nodeId) return 0;
	const state = loadDAGState(cwd);
	if (!state) return 0;
	return state.nodes.find(n => n.nodeId === nodeId)?.correctionCount ?? 0;
}

/** 运行模式 */
type RunMode = "auto" | "single" | "parallel" | "chain";

/** 链式调用中单步失败处理策略 */
type ChainOnError = "stop" | "skip" | "retry";

/** 失败分类 */
type FailureType = "timeout" | "non_zero_exit" | "empty_output" | "low_quality" | "aborted" | "unknown";

/** 链式调用中的单步定义 */
interface ChainStep {
	expert: string;
	task: string;
	context?: string;
}

/** 链式调用单步执行结果 */
interface ChainStepResult {
	step: ChainStep;
	result: ExpertResult;
	success: boolean;
	failureType?: FailureType;
	retryCount: number;
}

/** 链式调用整体执行结果 */
interface ChainExecutionResult {
	steps: ChainStepResult[];
	finalOutput: string;
	successCount: number;
	failureCount: number;
	skippedCount: number;
}

// ============================================================
// P1-3: 链式调用工具函数
// ============================================================

/** 验证参数并推断运行模式 */
function validateAndInferMode(
	expertsLength: number,
	chainLength: number,
	explicitMode?: string,
): { mode: RunMode; error?: string } {
	if (explicitMode && explicitMode !== "auto") {
		if (explicitMode === "chain") {
			if (chainLength === 0) {
				return { mode: "chain", error: "Chain mode requires 'chain' parameter with at least one step" };
			}
			if (chainLength > MAX_CHAIN_STEPS) {
				return { mode: "chain", error: `Chain too long (${chainLength}). Max: ${MAX_CHAIN_STEPS}` };
			}
			return { mode: "chain" };
		}
		if (explicitMode === "single" || explicitMode === "parallel") {
			if (expertsLength === 0) {
				return { mode: explicitMode, error: `${explicitMode} mode requires at least one expert` };
			}
			return { mode: explicitMode };
		}
	}

	// auto 模式推断
	if (chainLength > 0) {
		if (chainLength > MAX_CHAIN_STEPS) {
			return { mode: "chain", error: `Chain too long (${chainLength}). Max: ${MAX_CHAIN_STEPS}` };
		}
		return { mode: "chain" };
	}
	if (expertsLength === 1) return { mode: "single" };
	if (expertsLength >= 2) return { mode: "parallel" };
	return { mode: "single", error: "No experts or chain specified" };
}

/** P1-3: 占位符替换 —— 将 {previous} 替换为上一步输出 */
function substitutePlaceholders(template: string, previousOutput: string): string {
	let result = template;
	result = result.replace(/\{previous\}/g, previousOutput);
	result = result.replace(/\{previous:brief\}/g,
		previousOutput.length > 2000
			? previousOutput.slice(0, 2000) + "\n\n[... output truncated ...]"
			: previousOutput
	);
	result = result.replace(/\{previous:summary\}/g,
		previousOutput.length > 500
			? previousOutput.slice(0, 500) + "\n\n[... output truncated ...]"
			: previousOutput
	);
	const severityMatch = previousOutput.match(/严重等级[：:]\s*(P[012])/);
	result = result.replace(/\{previous:severity\}/g, severityMatch ? severityMatch[1] : "unknown");
	return result;
}

/** P1-3: 对专家执行结果进行分类 */
function classifyFailure(result: ExpertResult): FailureType {
	if (result.exitCode !== 0) {
		if (result.stderr?.includes("SIGTERM") || result.stderr?.includes("aborted")) {
			return "aborted";
		}
		if (result.stderr?.includes("timeout") || result.stderr?.includes("ETIMEDOUT")) {
			return "timeout";
		}
		return "non_zero_exit";
	}
	const output = getFinalOutput(result.messages);
	if (!output.trim()) return "empty_output";
	if (output.length < 100 && !parseSeverity(output)) {
		return "low_quality";
	}
	return "unknown";
}

/** P1-3: 构建重试任务描述 */
function buildRetryTask(step: ChainStep, failureType: FailureType, attempt: number): string {
	const failureHints: Record<FailureType, string> = {
		timeout: "Previous attempt timed out. Please provide a more concise response.",
		non_zero_exit: "Previous attempt failed with a non-zero exit code. Please check the task and retry.",
		empty_output: "Previous attempt produced no output. Please ensure you respond to the task.",
		low_quality: "Previous output was too brief or lacked proper analysis. Please provide a more detailed response with severity levels (P0/P1/P2).",
		aborted: "Previous attempt was aborted. Please try again.",
		unknown: "Previous attempt had an unknown failure. Please retry the task.",
	};

	return [
		`## Retry (Attempt ${attempt}/${MAX_CHAIN_RETRIES})`,
		``,
		`> ⚠️ ${failureHints[failureType]}`,
		``,
		`### Original Task`,
		step.task,
	].join("\n");
}

/** P1-3: 构建跳过步骤的哨兵结果 */
function buildSkipSentinel(step: ChainStep, failureType: FailureType): ChainStepResult {
	return {
		step,
		result: {
			expert: step.expert,
			task: step.task,
			exitCode: -1,
			messages: [],
			stderr: `Skipped due to: ${failureType}`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			severity: "P1",
		},
		success: false,
		failureType,
		retryCount: 0,
	};
}

// ============================================================
// P1-3: 链式执行引擎
// ============================================================

async function executeChain(
	chainSteps: ChainStep[],
	agents: AgentConfig[],
	defaultCwd: string,
	signal: AbortSignal | undefined,
	intensity: string,
	intensityHints: Record<string, string>,
	dagContextFile: string | null,
	chainOnError: ChainOnError,
): Promise<ChainExecutionResult> {
	const steps: ChainStepResult[] = [];
	let previousOutput = "";

	for (let i = 0; i < chainSteps.length; i++) {
		const step = chainSteps[i];
		const agent = agents.find(a => a.name === step.expert);

		if (!agent) {
			const sentinel = buildSkipSentinel(step, "unknown");
			steps.push(sentinel);
			previousOutput = `[Unknown expert: "${step.expert}"]`;
			if (chainOnError === "stop") break;
			continue;
		}

		const resolvedTask = substitutePlaceholders(step.task, previousOutput);

		const fullTask = step.context
			? `${resolvedTask}\n\n## 评审材料\n\n${step.context}\n${intensityHints[intensity]}`
			: `${resolvedTask}${intensityHints[intensity]}`;

		let stepResult: ExpertResult | null = null;
		let retryCount = 0;
		let success = false;
		let failureType: FailureType | undefined;

		while (retryCount <= MAX_CHAIN_RETRIES) {
			const taskToRun = retryCount === 0
				? fullTask
				: `${buildRetryTask(step, failureType!, retryCount)}\n\n${fullTask}`;

			stepResult = await runExpert(defaultCwd, agent, taskToRun, signal, dagContextFile ?? undefined);
			const output = getFinalOutput(stepResult.messages);

			if (stepResult.exitCode === 0 && output.trim().length > 0) {
				success = true;
				previousOutput = output;
				break;
			}

			retryCount++;
			failureType = classifyFailure(stepResult);

			if (chainOnError === "stop") break;
			if (chainOnError === "skip") break;
		}

		if (!success) {
			failureType = failureType ?? classifyFailure(stepResult!);

			if (chainOnError === "stop") {
				steps.push({
					step,
					result: stepResult!,
					success: false,
					failureType,
					retryCount,
				});
				break;
			}

			if (chainOnError === "skip" || (chainOnError === "retry" && retryCount >= MAX_CHAIN_RETRIES)) {
				const sentinel = buildSkipSentinel(step, failureType);
				sentinel.retryCount = retryCount;
				steps.push(sentinel);
				previousOutput = `[Step skipped: ${failureType}]`;
				continue;
			}
		}

		steps.push({
			step,
			result: stepResult!,
			success: true,
			failureType: undefined,
			retryCount: 0,
		});

		previousOutput = getFinalOutput(stepResult!.messages);
	}

	const successCount = steps.filter(s => s.success).length;
	const failureCount = steps.filter(s => !s.success && s.failureType !== undefined).length;
	const skippedCount = steps.filter(s => !s.success && s.result.exitCode === -1).length;

	const summaries = steps.map((s, i) => {
		const prefix = s.success ? "✅" : "❌";
		const sev = s.success ? parseSeverity(getFinalOutput(s.result.messages)) : undefined;
		return `${prefix} Step ${i + 1}: ${s.step.expert} — ${s.step.task.slice(0, 80)}${sev ? ` [${sev}]` : ""}`;
	});

	const finalOutput = [
		`## Chain Execution: ${successCount}/${steps.length} completed`,
		``,
		...summaries,
		``,
		`---`,
		`*Success: ${successCount} | Failed: ${failureCount} | Skipped: ${skippedCount}*`,
	].join("\n");

	return { steps, finalOutput, successCount, failureCount, skippedCount };
}

// ============================================================
// 专家子代理执行器（v2.1.0: 新增 dagContextFile 参数）
// ============================================================

async function runExpert(
	defaultCwd: string,
	agent: AgentConfig,
	task: string,
	signal: AbortSignal | undefined,
	/** P1-4: DAG 上下文文件路径（自动注入到子代理系统提示词） */
	dagContextFile?: string,
	/** P1-6: PI Extension API（用于事件发射） */
	pi?: ExtensionAPI,
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

	// P1-6: 发射 workunit:started 事件
	pi?.events.emit("omnipm:workunit:started", {
		expert: agent.name, task: task.slice(0, 200),
		timestamp: new Date().toISOString(),
	});

	try {
		// 构建系统提示词：专家提示词 + 可选的 DAG 上下文
		let systemPrompt = agent.systemPrompt;
		if (dagContextFile && fs.existsSync(dagContextFile)) {
			try {
				const dagContent = fs.readFileSync(dagContextFile, "utf-8");
				systemPrompt = `${agent.systemPrompt}\n\n---\n\n## DAG Execution Context (Auto-Injected)\n\n${dagContent}`;
			} catch {
				// 读取 DAG 上下文失败，降级：仅使用专家提示词
			}
		}

		// 写入系统提示词到临时文件
		const tmp = await writeTempFile(agent.name, systemPrompt);
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

		// P1-6: 发射完成/失败事件
		if (result.exitCode === 0) {
			pi?.events.emit("omnipm:workunit:completed", {
				expert: agent.name,
				severity: parseSeverity(getFinalOutput(result.messages)),
				usage: result.usage, model: result.model,
				timestamp: new Date().toISOString(),
			});
		} else {
			pi?.events.emit("omnipm:workunit:failed", {
				expert: agent.name, exitCode: result.exitCode,
				stderr: result.stderr.slice(0, 500),
				timestamp: new Date().toISOString(),
			});
		}

		// v2.1.1: 提取专家声明的输出文件路径
		result.claimed_files = extractClaimedFiles(getFinalOutput(result.messages));

		return result;
	} finally {
		if (tmpPath) try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
		if (tmpDir) try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
	}
}

// ============================================================
// 参数 Schema（v2.1.0: 新增 mode/chain/chainOnError，experts 改为 Optional）
// ============================================================

const ExpertTask = Type.Object({
	expert: Type.String({ description: "专家名称 (architect/security/backend/frontend/database/qa/devops/requirements/course-designer/content-reviewer/market-analyst/seo-expert/media-producer)" }),
	task: Type.String({ description: "委派给专家的具体任务描述" }),
	context: Type.Optional(Type.String({ description: "评审所需的上下文材料（设计文档/代码等）" })),
});

const ChainStepSchema = Type.Object({
	expert: Type.String({ description: "专家名称" }),
	task: Type.String({ description: "任务描述。支持占位符: {previous} = 前一步完整输出, {previous:brief} = 前2000字符, {previous:summary} = 前500字符, {previous:severity} = 前一步严重等级" }),
	context: Type.Optional(Type.String({ description: "评审所需的上下文材料" })),
});

const ExpertIntensity = StringEnum(["LIGHT", "STANDARD", "DEEP", "PAIR"] as const, {
	description: "专家调用强度: LIGHT=快速扫描, STANDARD=标准评审, DEEP=深度审查, PAIR=双人结对",
	default: "STANDARD",
});

const RunExpertsParams = Type.Object({
	/** P1-3: experts 改为 Optional —— 链式调用时使用 chain 字段即可 */
	experts: Type.Optional(Type.Array(ExpertTask, { description: "要调度的专家和任务列表。单专家传入1个，多专家并行传入2-8个。链式模式时可省略，改用 chain 参数。" })),
	intensity: Type.Optional(ExpertIntensity),
	agentScope: Type.Optional(StringEnum(["omnipm", "user", "both"] as const, { default: "omnipm" })),
	/** P1-3: 运行模式 */
	mode: Type.Optional(StringEnum(["auto", "single", "parallel", "chain"] as const, {
		description: "运行模式: auto=自动推断, single=单专家, parallel=多专家并行, chain=链式调用",
		default: "auto",
	})),
	/** P1-3: 链式调用步骤定义 */
	chain: Type.Optional(Type.Array(ChainStepSchema, {
		description: "链式调用步骤序列。每一步的 task 可使用 {previous} 占位符引用前一步输出。最多 10 步。",
	})),
	/** P1-3: 链式调用失败处理策略 */
	chainOnError: Type.Optional(StringEnum(["stop", "skip", "retry"] as const, {
		description: "链式调用失败处理: stop=立即停止整条链, skip=跳过失败步骤继续, retry=重试(最多3次)后跳过",
		default: "stop",
	})),
});

const OmniDAGOutputs = Type.Object({
	files: Type.Optional(Type.Array(Type.String(), { description: "产出文件路径列表（相对于项目根目录）" })),
	keyDecisions: Type.Optional(Type.Array(Type.String(), { description: "关键决策记录" })),
	artifacts: Type.Optional(Type.Array(Type.String(), { description: "产出物描述" })),
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
		/** P0-3: GATE 节点类型标记，Extension 层会强制确认才能标记完成 */
		type: Type.Optional(StringEnum(["ANALYSIS", "DESIGN", "REVIEW", "DEVELOP", "TEST", "DELIVER", "GATE"] as const, { description: "节点类型。GATE 节点在 complete 时需额外传入 confirmed=true" })),
	}), { description: "DAG节点定义（init时必填）" })),
	nodeId: Type.Optional(Type.String({ description: "节点ID（start/complete/fail时必填）" })),
	failReason: Type.Optional(Type.String({ description: "失败原因（fail时填写）" })),
	/** P0-3: GATE 节点完成确认（仅 GATE 类型节点 complete 时必填） */
	confirmed: Type.Optional(Type.Boolean({ description: "GATE节点确认标志。GATE类型节点必须 confirmed=true 才能标记完成。" })),
	/** P0-1: complete 时传入节点产出物，Extension 验证文件存在性后才标记 done */
	outputs: Type.Optional(OmniDAGOutputs, { description: "节点产出物（complete时传入）。files 中的路径会被逐一验证存在性，全部通过后才标记节点完成。" }),
});

// ============================================================
// Extension 入口
// ============================================================

export default function (pi: ExtensionAPI) {
	
	// --------------------------------------------------
	// 工具 1: run_experts — 单/并行/链式专家评审（v2.1.0）
	// --------------------------------------------------
	pi.registerTool({
		name: "run_experts",
		label: "Run Experts",
		description: [
			"调度 OmniPM 专家子代理进行独立/并行/链式评审。",
			"每位专家在独立 pi 进程中运行，拥有隔离的上下文窗口。",
			"",
			"支持 3 种运行模式:",
			"- single: 单专家评审（默认，experts 数组1个元素）",
			"- parallel: 多专家并行评审（experts 数组2-8个元素，最多4个并发）",
			"- chain: 链式调用（使用 chain 参数定义步骤序列，支持 {previous} 上下文传递）",
			"",
			"支持 13 位 OmniPM 内置专家：",
			"architect(系统架构师), security(安全专家), backend(后端专家), frontend(前端专家),",
			"database(数据库专家), qa(测试架构师), devops(DevOps), requirements(需求分析师),",
			"course-designer(教学设计), content-reviewer(内容审核), market-analyst(市场分析),",
			"seo-expert(SEO), media-producer(媒体制作)",
			"",
			"专家输出包含严重等级(P0/P1/P2)，Orion 据此综合决议。",
			"v2.1.0: 自动注入 DAG 执行上下文到子代理。",
		].join(" "),
		parameters: RunExpertsParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const scope: AgentScope = params.agentScope ?? "omnipm";
			const discovery = discoverAgents(ctx.cwd, scope);
			const agents = discovery.agents;
			const intensity = params.intensity ?? "STANDARD";

			const expertsList = params.experts ?? [];
			const chainList = params.chain ?? [];
			const chainOnError: ChainOnError = params.chainOnError ?? "stop";

			// P1-3: 模式推断
			const modeResult = validateAndInferMode(expertsList.length, chainList.length, params.mode);
			if (modeResult.error) {
				const available = agents.map(a => `"${a.name}"`).join(", ") || "none";
				return {
					content: [{ type: "text", text: `${modeResult.error}\n\nAvailable experts: ${available}` }],
					details: { mode: "error", results: [] },
				};
			}

			const mode = modeResult.mode;

			// P1-4: 准备 DAG 上下文文件（所有模式共享）
			const dagContextFile = prepareDAGContextFile(ctx.cwd);

			// 强度提示词追加
			const intensityHints: Record<string, string> = {
				LIGHT: "\n\n## 调用强度: LIGHT\n快速扫描，输出 2-3 条核心建议即可。不需要展开详细分析。",
				STANDARD: "\n\n## 调用强度: STANDARD\n标准评审，输出至少 3 条建议，标注严重等级 P0/P1/P2。",
				DEEP: "\n\n## 调用强度: DEEP\n深度审查，逐项检查，输出至少 5 条建议，标注严重等级。对每个建议给出具体修正方案。",
				PAIR: "\n\n## 调用强度: PAIR\n结对评审模式。你需要关注与其他专家的交叉领域，在输出中标注需要联合讨论的议题。",
			};

			// ================================================================
			// P1-3: 链式调用模式
			// ================================================================
			if (mode === "chain") {
				const chainResult = await executeChain(
					chainList,
					agents,
					ctx.cwd,
					signal,
					intensity,
					intensityHints,
					dagContextFile,
					chainOnError,
				);

				const stepDetails = chainResult.steps.map(s => {
					const output = getFinalOutput(s.result.messages);
					const sev = s.success ? parseSeverity(output) : undefined;
					return {
						expert: s.step.expert,
						task: s.step.task.slice(0, 100),
						success: s.success,
						failureType: s.failureType,
						retryCount: s.retryCount,
						severity: sev,
						outputPreview: output.slice(0, PER_EXPERT_OUTPUT_CAP),
						usage: s.result.usage,
						model: s.result.model,
					};
				});

				return {
					content: [{ type: "text", text: chainResult.finalOutput }],
					details: {
						mode: "chain",
						successCount: chainResult.successCount,
						failureCount: chainResult.failureCount,
						skippedCount: chainResult.skippedCount,
						steps: stepDetails,
					},
				};
			}

			// ================================================================
			// 单专家模式
			// ================================================================
			if (mode === "single") {
				const et = expertsList[0];
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

				const result = await runExpert(ctx.cwd, agent, fullTask, signal, dagContextFile ?? undefined);
				const output = getFinalOutput(result.messages);
				const sev = parseSeverity(output);

				return {
					content: [{
						type: "text",
						text: `${formatDAGSuggestionBlock(generateDAGSuggestion(params.nodeId ?? "single", [result], getCorrectionCount(ctx.cwd, params.nodeId)))}

## ${agent.name} 评审意见\n\n${output || "(no output)"}\n\n---\n*严重等级: ${sev || "未标注"} | ${formatUsage(result.usage, result.model)}*`,
					}],
					details: { mode: "single", results: [{ ...result, severity: sev }], dag_suggestion: generateDAGSuggestion(params.nodeId ?? "single", [result], getCorrectionCount(ctx.cwd, params.nodeId)) },
				};
			}

			// ================================================================
			// 并行模式
			// ================================================================
			if (expertsList.length > MAX_PARALLEL_EXPERTS) {
				return {
					content: [{ type: "text", text: `Too many experts (${expertsList.length}). Max: ${MAX_PARALLEL_EXPERTS}` }],
					details: { mode: "parallel", results: [] },
				};
			}

			const allResults: ExpertResult[] = [];
			
			const results = await mapConcurrency(expertsList, MAX_CONCURRENCY, async (et) => {
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

				return await runExpert(ctx.cwd, agent, fullTask, signal, dagContextFile ?? undefined);
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
					text: `${formatDAGSuggestionBlock(generateDAGSuggestion(params.nodeId ?? "parallel", allResults, getCorrectionCount(ctx.cwd, params.nodeId)))}

## 并行专家评审: ${successCount}/${results.length} 完成\n\n${summaries.join("\n\n---\n\n")}`,
				}],
				details: { mode: "parallel", results: allResults.map(r => ({ ...r, severity: parseSeverity(getFinalOutput(r.messages)) })), dag_suggestion: generateDAGSuggestion(params.nodeId ?? "parallel", allResults, getCorrectionCount(ctx.cwd, params.nodeId)) },
			};
		},

		renderCall(args, theme, _context) {
			const mode = args.mode ?? "auto";
			const expertsCount = args.experts?.length || 0;
			const chainCount = args.chain?.length || 0;

			let label: string;
			let names: string;

			if (mode === "chain" || (mode === "auto" && chainCount > 0)) {
				label = `chain (${chainCount} steps)`;
				names = args.chain?.map((s: any) => s.expert).join(" → ") || "...";
			} else if (expertsCount > 1) {
				label = `parallel (${expertsCount})`;
				names = args.experts?.map((e: any) => e.expert).join(", ") || "...";
			} else {
				label = "single";
				names = args.experts?.[0]?.expert || "...";
			}

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
	// 工具 2: omni_dag — DAG 状态管理（v2.1.0: reset 清理上下文文件）
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
			"reset: 重置 DAG 状态，同时清理 DAG 上下文缓存文件。",
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
							nodeType: n.type as DAGNodeState["nodeType"],
							correctionCount: 0,
						})),
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					};
					dagStates.set(cwd, state);
					saveDAGState(cwd, state);

					// P1-4: init 时预生成 DAG 上下文
					prepareDAGContextFile(cwd);

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

					// P0-3: GATE 门控硬阻断 —— 存在未确认 GATE 时禁止启动新节点
					const unconfirmedGates = state.nodes.filter(n =>
						n.nodeType === "GATE" && n.status !== "done" && n.status !== "pending"
					);
					if (unconfirmedGates.length > 0 && node.nodeType !== "GATE") {
						const gateList = unconfirmedGates.map(g => `  - ${g.nodeId}: ${g.name} [${g.status}]`).join("
");
						return {
							content: [{
								type: "text",
								text: `⛔ 存在未确认的 GATE 门控节点，不允许启动新节点:
${gateList}

请先完成 GATE 确认：omni_dag complete(nodeId: "<gate_id>", confirmed: true)`,
							}],
						};
					}
					
					node.status = "running";
					node.startedAt = new Date().toISOString();
					state.currentNode = params.nodeId;
					state.updatedAt = new Date().toISOString();
					saveDAGState(cwd, state);

					// P1-4: 更新 DAG 上下文
					prepareDAGContextFile(cwd);
					
					return { content: [{ type: "text", text: `▶ 开始节点: ${node.name} (${node.nodeId})` }] };
				}

				case "complete": {
					if (!state) return { content: [{ type: "text", text: "No DAG. Use 'init' first." }] };
					if (!params.nodeId) return { content: [{ type: "text", text: "nodeId required" }] };
					
					const node = state.nodes.find(n => n.nodeId === params.nodeId);
					if (!node) return { content: [{ type: "text", text: `Node "${params.nodeId}" not found` }] };

					// P0-3: GATE 节点硬阻断 —— 必须用户显式确认才能标记完成
				if (node.nodeType === "GATE" && !params.confirmed) {
					return {
						content: [{
							type: "text",
							text: `⛔ GATE 节点需要显式确认: ${node.name}

这是一个 GATE 门控节点，必须由用户确认后才能继续。
请使用: omni_dag complete(nodeId: "${params.nodeId}", confirmed: true, outputs: {...})`,
						}],
					};
				}

				// P0-1: outputs 文件存在性验证（DEVELOP/DELIVER 节点的强制自检）
				const outputs = params.outputs;
					if (outputs?.files && outputs.files.length > 0) {
						const missingFiles: string[] = [];
						for (const f of outputs.files) {
							const resolved = path.resolve(cwd, f);
							try {
								if (!fs.existsSync(resolved)) missingFiles.push(f);
							} catch { missingFiles.push(f); }
						}
						if (missingFiles.length > 0) {
							return {
								content: [{
									type: "text",
									text: `⛔ 节点完成验证失败: ${node.name}

声称的 ${outputs.files.length} 个文件中，${missingFiles.length} 个不存在:
${missingFiles.map(f => `  - ${f}`).join("
")}

节点未标记为完成。请检查文件是否已正确写入后重新 complete。`,
								}],
							};
						}
					}
					
					node.status = "done";
					node.completedAt = new Date().toISOString();
					node.correctionCount = 0;
					if (outputs) {
						node.outputs = {
							files: outputs.files || [],
							keyDecisions: outputs.keyDecisions || [],
							artifacts: outputs.artifacts || [],
						};
					}
					state.updatedAt = new Date().toISOString();
					saveDAGState(cwd, state);

					// P1-4: 更新 DAG 上下文
					prepareDAGContextFile(cwd);
					
					const doneCount = state.nodes.filter(n => n.status === "done").length;
					const total = state.nodes.length;
					const verifiedInfo = outputs?.files?.length ? `
已验证产出: ${outputs.files.length} 个文件` : "";
					
					return {
						content: [{
							type: "text",
							text: `✅ 完成节点: ${node.name}${verifiedInfo}

进度: ${doneCount}/${total} (${Math.round(doneCount/total*100)}%)`,
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
						prepareDAGContextFile(cwd);
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
					prepareDAGContextFile(cwd);
					
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
					// P1-4: 清理 DAG 上下文 Markdown 文件
					try { fs.unlinkSync(getDAGMarkdownPath(cwd)); } catch { /* ignore */ }
					return { content: [{ type: "text", text: "DAG 状态已重置。DAG 上下文缓存已清理。" }] };
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
	// P1-4: tool_call 钩子 —— 自动注入 DAG_CONTEXT
	// --------------------------------------------------
	pi.on("tool_call", async (event: any, ctx: any) => {
		// 仅拦截 run_experts 工具调用
		if (event?.toolName !== "run_experts") return;

		// 熔断器检查
		tryResetCircuitBreaker();

		if (!circuitBreakerOpen) {
			try {
				// 在 run_experts 执行前确保 DAG 上下文是最新的
				prepareDAGContextFile(ctx.cwd);
			} catch {
				recordDegradation();
				if (ctx.ui?.notify) {
					ctx.ui.notify(
						"OmniPM: DAG context refresh failed (degraded mode)",
						"warning",
					);
				}
			}
		}
	});

	// --------------------------------------------------
	// Session Hook: 注入 OmniPM 工具清单 + 重置降级状态
	// --------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		// P1-4: 每次 session 启动时重置降级状态
		degradationCounter = 0;
		circuitBreakerOpen = false;
		circuitBreakerOpenedAt = null;

		// P1-4: 清理可能残留的 DAG 上下文文件（旧 session 遗留）
		try {
			const mdPath = getDAGMarkdownPath(ctx.cwd);
			if (fs.existsSync(mdPath)) fs.unlinkSync(mdPath);
		} catch { /* ignore */ }

		const discovery = discoverAgents(ctx.cwd, "omnipm");
		const expertNames = discovery.agents.map(a => a.name).join(", ");
		ctx.ui.notify(
			`OmniPM v2.1.0: ${discovery.agents.length} experts loaded (${expertNames})`,
			"info",
		);
	});

	console.log("OmniPM Orion Extension v2.1.1 loaded. Tools: run_experts (single/parallel/chain), omni_dag; Events: workunit(started/completed/failed); v2.1.2: P0-1 outputs验证 + P0-2 DEVELOP自检 + P0-3 GATE硬阻断 + claimed_files+verifyOutputs+DAG_SUGGESTION+correctionLoop");
}
