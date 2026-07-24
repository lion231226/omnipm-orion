/**
 * OmniPM Orion Extension — 多专家并行/链式执行引擎 (v2.5.0)
 * 
 * 为 PI Agent 注册 OmniPM 专属工具：
 * - run_experts: 单/并行/链式调度专家子代理（独立 pi 进程）
 * - omni_dag: DAG 执行状态管理（检查点/恢复/熔断）
 * - condition_branch: 可编程条件分支（v2.4.0新增）
 * 
 * v2.5.0 新增:
 * - NSG Auto-Maintenance: NEXT_SESSION_GUIDE.md 自动维护（omni_dag 生命周期驱动）
 * - Session Recovery: session_start 自动检测未完成 DAG + 注入恢复提示
 * 
 * v2.4.0 新增:
 * - Events Bus: 跨工具事件通信（omni_dag↔run_experts）
 * - Condition Branch: 基于专家输出的条件分支路由
 * - Enhanced DAG Context: 上游摘要+BFS遍历+强度感知裁剪
 * - Retrospective Engine: 项目复盘自动学习
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

// v2.4.0: 新模块导入
import { OmniPMEventEmitter } from "./runtime/events.ts";
import { ConditionEvaluator, BranchExecutor, type ConditionBranch } from "./runtime/condition-branch.ts";
import { createDAGContextForExpert, DAGContextManager, getInjectionConfig } from "./runtime/dag-context.ts";
import { createRetrospectiveEngine, type ExecutionRecord } from "./runtime/retrospective.ts";
// v2.5.0: 专家输出质量评分
import { scoreExpertQuality, type ExpertQualityScore } from "./runtime/dag-utils.ts";
// v2.4.0: CDL 能力自发现层
import { CDLDetector, CDLOrchestrator, QScoreCalculator, CDLCache, formatCDLStatusAsMarkdown, formatCDLGateDesignBlock, type CDLStatus, type CDLSearchResult } from "./runtime/cdl.ts";
// v2.7.0: 共享符号层 (F1) + 诊断日志 (F10) + Schema迁移 (F12)
import { type ModelConfig, MODEL_REGISTRY, getModelConfig, atomicWriteJSON, cleanupOrphanedTmpFiles } from "./tools/shared.ts";
import { Diagnostics } from "./runtime/diagnostics.ts";
import { safeLoadDAGState } from "./runtime/migrations.ts";

/** v2.4.0(R2): 输出内容诊断 —— 统计 text vs tool_use 比例 */
function diagnoseOutput(messages: Message[]): { textChars: number; toolUseCount: number; textBlocks: number } {
	let textChars = 0;
	let toolUseCount = 0;
	let textBlocks = 0;
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "text" && part.text) {
				textChars += part.text.length;
				textBlocks++;
			}
			if (part.type === "tool_use") {
				toolUseCount++;
			}
		}
	}
	return { textChars, toolUseCount, textBlocks };
}

const MAX_PARALLEL_EXPERTS = 8;
const MAX_CONCURRENCY = 4;
const PER_EXPERT_OUTPUT_CAP = 50 * 1024;
const MAX_CORRECTIONS_PER_NODE = 3;

// v2.5.0: 专家质量日志路径
const QUALITY_LOG_FILENAME = "omnipm_quality_log.json";

function getQualityLogPath(cwd: string): string {
	return path.join(cwd, ".pi", QUALITY_LOG_FILENAME);
}

/** 加载质量日志 */
function loadQualityLog(cwd: string): ExpertQualityScore[] {
	try {
		const p = getQualityLogPath(cwd);
		if (!fs.existsSync(p)) return [];
		return JSON.parse(fs.readFileSync(p, "utf-8"));
	} catch { Diagnostics.warn(cwd, "quality_log", "质量日志读取失败"); return []; }
}

/** 追加一条质量评分到日志 */
function appendQualityLog(cwd: string, score: ExpertQualityScore): void {
	const log = loadQualityLog(cwd);
	log.push(score);
	// 只保留最近 100 条评分，防止文件膨胀
	const trimmed = log.length > 100 ? log.slice(-100) : log;
	const p = getQualityLogPath(cwd);
	const dir = path.dirname(p);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(p, JSON.stringify(trimmed, null, 2), "utf-8");
}

/** 评分专家输出并写入日志 */
function scoreAndLogExpert(
	cwd: string,
	expert: string,
	task: string,
	output: string,
	intensity?: string,
	stopReason?: string,
): ExpertQualityScore | null {
	try {
		const score = scoreExpertQuality({
			expert, task, output,
			intensity: intensity as ExpertQualityScore["grade"] extends string ? any : any,
			stopReason,
		});
		appendQualityLog(cwd, score);
		return score;
	} catch {
		return null;
	}
}

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
	/** v2.7.0(F11): 前置依赖节点ID列表 */
	dependsOn?: string[];
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
	if (!fs.existsSync(p)) return null;
	// v2.7.0(F12): 使用 safeLoadDAGState（含Schema迁移+备份降级）
	return safeLoadDAGState(p) as DAGState | null;
}

function saveDAGState(cwd: string, state: DAGState): void {
	const p = getDAGStatePath(cwd);
	const dir = path.dirname(p);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	state.updatedAt = new Date().toISOString();
	// v2.7.0(F6): 原子写入替代 writeFileSync
	atomicWriteJSON(p, state);
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
// v2.5.0: NEXT_SESSION_GUIDE.md Auto-Maintenance (DEV-7)
// ============================================================

const NSG_FILENAME = "NEXT_SESSION_GUIDE.md";

/** Sentinel markers for auto-maintained sections in NEXT_SESSION_GUIDE.md */
const NSG_MARKERS = {
	progress:   { start: "<!-- OMNI_AUTO:progress -->", end: "<!-- /OMNI_AUTO:progress -->" },
	nextTask:   { start: "<!-- OMNI_AUTO:next_task -->", end: "<!-- /OMNI_AUTO:next_task -->" },
	section6:   { start: "<!-- OMNI_AUTO:section6 -->", end: "<!-- /OMNI_AUTO:section6 -->" },
	recovery:   { start: "<!-- OMNI_AUTO:recovery -->", end: "<!-- /OMNI_AUTO:recovery -->" },
} as const;

function nsgPath(cwd: string): string { return path.join(cwd, NSG_FILENAME); }

/** Replace content between sentinel markers. Returns null if markers not found. */
function replaceBetween(content: string, startMarker: string, endMarker: string, replacement: string): string | null {
	const si = content.indexOf(startMarker);
	const ei = content.indexOf(endMarker);
	if (si === -1 || ei === -1 || ei <= si) return null;
	return content.slice(0, si + startMarker.length) + "\n" + replacement + "\n" + content.slice(ei);
}

/** Escape regex special characters */
function escapeRegex(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * Auto-update NEXT_SESSION_GUIDE.md after each DAG state change.
 * Updates: header progress line, next task, §六 startup instructions.
 */
function maintainNextSessionGuide(cwd: string, state: DAGState): void {
	const p = nsgPath(cwd);
	let content: string;
	try { content = fs.readFileSync(p, "utf-8"); }
	catch { return; }

	const done = state.nodes.filter(n => n.status === "done").length;
	const total = state.nodes.length;
	const pct = total > 0 ? Math.round(done / total * 100) : 0;
	const allDone = done === total;
	const pendingNodes = state.nodes.filter(n => n.status !== "done" && n.status !== "blocked");
	const blockedNodes = state.nodes.filter(n => n.status === "blocked");

	// 1. Progress line
	const progressText = allDone
		? `${state.projectName} 完成（${total}/${total} DAG节点）✅ | ${new Date().toISOString().slice(0, 10)}`
		: `${state.projectName} 进行中（${done}/${total}，${pct}%）| ${new Date().toISOString().slice(0, 10)}`;
	let updated = replaceBetween(content, NSG_MARKERS.progress.start, NSG_MARKERS.progress.end, progressText);
	if (updated) content = updated;

	// 2. Next task
	let nextTask: string;
	if (allDone) nextTask = "全部节点已完成 ✅";
	else if (pendingNodes.length > 0) nextTask = `继续执行: ${pendingNodes[0].nodeId} - ${pendingNodes[0].name}`;
	else if (blockedNodes.length > 0) nextTask = `⚠️ 处理阻塞节点: ${blockedNodes.map(n => n.nodeId).join(", ")}`;
	else nextTask = "待定";
	updated = replaceBetween(content, NSG_MARKERS.nextTask.start, NSG_MARKERS.nextTask.end, nextTask);
	if (updated) content = updated;

	// 3. §六 startup instructions
	const section6 = buildNSGStartupInstructions(state, done, total, pct, pendingNodes, blockedNodes);
	updated = replaceBetween(content, NSG_MARKERS.section6.start, NSG_MARKERS.section6.end, section6);
	if (updated) content = updated;

	fs.writeFileSync(p, content, "utf-8");
}

/** Build auto-generated §六 new-session startup instructions */
function buildNSGStartupInstructions(
	state: DAGState, done: number, total: number, pct: number,
	pendingNodes: DAGNodeState[], blockedNodes: DAGNodeState[],
): string {
	const lines: string[] = ["", "```", "@OMNIPM_SYSTEM_PROMPT.md", "", "你是 Orion v2.5.0。新会话启动。", "",
		"请读取：", "1. PROJECT_MEMORY.md       — 项目状态 + 偏差清单",
		"2. NEXT_SESSION_GUIDE.md   — 本文件（含自动恢复信息）",
		"3. OMNIPM_SYSTEM_PROMPT.md — 系统提示词", "",
		"═══════════════════════════════════════"];

	if (pendingNodes.length > 0) {
		const next = pendingNodes[0];
		lines.push(`DAG: ${state.projectName} | 进度: ${done}/${total} (${pct}%)`,
			`下一节点: ${next.nodeId} - ${next.name}`,
			"═══════════════════════════════════════", "",
			"执行流程：",
			`1. omni_dag start(nodeId: "${next.nodeId}") 开始节点`,
			"2. 按节点要求调度专家 → 产出 → 验证",
			'3. omni_dag complete(nodeId: "...", outputs: {...}) 标记完成',
			"4. 继续下一节点或验收");
	} else if (blockedNodes.length > 0) {
		lines.push(`⚠️ 阻塞: ${state.projectName}`,
			`阻塞节点: ${blockedNodes.map(n => `${n.nodeId}(${n.correctionCount}次失败)`).join(", ")}`,
			"═══════════════════════════════════════", "",
			"请先处理阻塞节点再继续。");
	} else {
		lines.push(`✅ DAG完成: ${state.projectName} (${total}/${total})`,
			"═══════════════════════════════════════", "",
			"全部节点已完成。请进行最终验收。");
	}
	lines.push("```", "");
	return lines.join("\n");
}

/**
 * Inject recovery notice at top of NEXT_SESSION_GUIDE.md on session_start.
 * Only injects if there is an incomplete DAG.
 */
function injectRecoveryNotice(cwd: string, state: DAGState): void {
	const p = nsgPath(cwd);
	let content: string;
	try { content = fs.readFileSync(p, "utf-8"); }
	catch { return; }

	// Remove any existing recovery notice first
	const rStart = content.indexOf(NSG_MARKERS.recovery.start);
	const rEnd = content.indexOf(NSG_MARKERS.recovery.end);
	if (rStart !== -1 && rEnd !== -1) {
		content = content.slice(0, rStart) + content.slice(rEnd + NSG_MARKERS.recovery.end.length);
		content = content.replace(/^\n+/, "");
	}

	const done = state.nodes.filter(n => n.status === "done").length;
	const total = state.nodes.length;
	const pendingNodes = state.nodes.filter(n => n.status !== "done" && n.status !== "blocked");
	const blockedNodes = state.nodes.filter(n => n.status === "blocked");

	const now = new Date().toISOString();
	const lines = [
		NSG_MARKERS.recovery.start, "",
		"> ⚡ **OmniPM 自动恢复检测** — " + now, ">",
		`> **DAG**: ${state.projectName} | **进度**: ${done}/${total} (${Math.round(done/total*100)}%)`,
		`> **最后活跃**: ${state.updatedAt || "未知"}`, ">",
		"> **✅ 已完成**: " + (state.nodes.filter(n => n.status === "done").map(n => n.nodeId).join(", ") || "无"),
		">",
	];

	if (pendingNodes.length > 0) {
		lines.push(`> **⬜ 待执行**: ${pendingNodes.map(n => n.nodeId).join(" → ")}`, ">",
			`> **📋 建议第一步**: omni_dag start(nodeId: "${pendingNodes[0].nodeId}")`);
	}
	if (blockedNodes.length > 0) {
		lines.push(`> **🚨 阻塞节点**: ${blockedNodes.map(n => `${n.nodeId}(${n.correctionCount}次)`).join(", ")}`,
			"> **⚠️ 需人工介入处理熔断节点**");
	}

	lines.push(">", "> ───────────────────────────",
		"> 将 NEXT_SESSION_GUIDE.md §六 粘贴为新对话第一条消息即可恢复。",
		"> ───────────────────────────", "", NSG_MARKERS.recovery.end, "");

	content = lines.join("\n") + "\n" + content;
	fs.writeFileSync(p, content, "utf-8");
}

/** Remove recovery notice (called when user starts actively working on the DAG) */
function clearRecoveryNotice(cwd: string): void {
	const p = nsgPath(cwd);
	let content: string;
	try { content = fs.readFileSync(p, "utf-8"); }
	catch { return; }

	const rStart = content.indexOf(NSG_MARKERS.recovery.start);
	const rEnd = content.indexOf(NSG_MARKERS.recovery.end);
	if (rStart !== -1 && rEnd !== -1) {
		content = content.slice(0, rStart) + content.slice(rEnd + NSG_MARKERS.recovery.end.length);
		content = content.replace(/^\n+/, "");
		fs.writeFileSync(p, content, "utf-8");
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

/** v2.3.1(D-2): 新增 stopReason 参数，暴露子代理终止原因 */
function formatUsage(usage: UsageStats, model?: string, stopReason?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns}t`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	if (stopReason) parts.push(`⏹${stopReason}`);
	return parts.join(" ");
}

/**
 * 提取子代理的最终输出文本。v2.3.1(D-2修复): 拼接所有 assistant 文本消息，
 * 而非仅取最后一条。这确保多轮分析（读文件→分析→再读→分析）的中间产出不丢失。
 */
function getFinalOutput(messages: Message[]): string {
	const parts: string[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text.trim()) {
					parts.push(part.text.trim());
				}
			}
		}
	}
	if (parts.length === 0) return "";
	// 单条消息直接返回；多条消息用分隔符拼接
	return parts.length === 1 ? parts[0] : parts.join("\n\n---\n\n");
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
		/已创建(?:文件)?[：:]\s*([^\s\n,，;；]+)/g,
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
	// v2.2.1: 检测空输出（子进程退出码为0但无任何消息 = 静默失败）
	const hasEmptyOutput = results.some(r => r.exitCode === 0 && getFinalOutput(r.messages).trim().length === 0);
	if (hasEmptyOutput) return { action: "retry", nodeId, reason: "专家无输出（空响应）", severity: "P0", correctionCount };
	// v2.3.1(D-2): 检测输出截断 —— stopReason=max_tokens 或输出末尾残缺
	const hasTruncated = results.some(r => isOutputTruncated(r));
	if (hasTruncated) {
		const names = results.filter(r => isOutputTruncated(r)).map(r => r.expert).join(", ");
		return { action: "retry", nodeId, reason: `${names} 输出疑似截断（stopReason=max_tokens）`, severity: "P1", correctionCount };
	}
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
type FailureType = "timeout" | "non_zero_exit" | "empty_output" | "low_quality" | "aborted" | "truncated" | "unknown";

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
	// v2.3.1(D-2): 优先检测截断
	if (isOutputTruncated(result)) return "truncated";
	if (output.length < 100 && !parseSeverity(output)) {
		return "low_quality";
	}
	return "unknown";
}

/** v2.3.1(D-2): 检测子代理输出是否被截断。
 *  检查 stopReason=max_tokens 及输出末尾是否残缺（未闭合的代码块、截断的句子等）。 */
function isOutputTruncated(result: ExpertResult): boolean {
	// 条件1: stopReason 显式指示 max_tokens 截断
	if (result.stopReason === "max_tokens" || result.stopReason === "token_limit") {
		return true;
	}
	// 条件2: 输出末尾启发式截断检测
	const output = getFinalOutput(result.messages);
	if (output.length < 50) return false; // 短输出不判截断

	// 检查未闭合的 markdown 代码块
	const fenceCount = (output.match(/```/g) || []).length;
	if (fenceCount % 2 !== 0) return true; // 奇数个 ``` = 未闭合

	// 检查结尾是否为截断模式（句子中间中断）
	const lastChars = output.slice(-20).trim();
	const truncationPatterns = [
		/[，,、]$/,        // 以逗号结尾
		/[（(]$/,           // 以开括号结尾
		/[:：]$/,           // 以冒号结尾（可能在列清单时截断）
		/["'][^"']*$/,     // 未闭合的引号
		/\[未完成/,         // 中文未完成标记
	];
	for (const pat of truncationPatterns) {
		if (pat.test(lastChars)) return true;
	}

	return false;
}

/** P1-3: 构建重试任务描述 */
function buildRetryTask(step: ChainStep, failureType: FailureType, attempt: number): string {
	const failureHints: Record<FailureType, string> = {
		timeout: "Previous attempt timed out. Please provide a more concise response.",
		non_zero_exit: "Previous attempt failed with a non-zero exit code. Please check the task and retry.",
		empty_output: "Previous attempt produced no output. Please ensure you respond to the task.",
		low_quality: "Previous output was too brief or lacked proper analysis. Please provide a more detailed response with severity levels (P0/P1/P2).",
		aborted: "Previous attempt was aborted. Please try again.",
		truncated: "Previous output was truncated (max_tokens or incomplete). Please provide a complete response. If reading many files, prioritize the most critical ones.",
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
	// v2.4.0(R2): 模型自识别 + 上下文窗口感知
	const modelName = agent.model || process.env.OMNIPM_EXPERT_MODEL || "";
	const modelConfig = getModelConfig(modelName);
	
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (modelConfig.model) args.push("--model", modelConfig.model);
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
			// v2.2.1: 诊断日志——记录实际执行的命令
			result.stderr += `[omni_diag] cmd: ${invocation.command} ${invocation.args.slice(0, 3).join(" ")}...
`;
			
			let proc: ReturnType<typeof spawn>;
			try {
				proc = spawn(invocation.command, invocation.args, {
					cwd: defaultCwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (spawnErr: any) {
				result.stderr += `[omni_diag] spawn failed: ${spawnErr?.message || "unknown"}
`;
				resolve(127);
				return;
			}

			// v2.7.0(F7): 可配置超时保护（默认300s）
t		const spawnTimeoutMs = parseInt(process.env.OMNIPM_SPAWN_TIMEOUT_MS || "") || 300_000;
			const timeout = setTimeout(() => {
				result.stderr += `[omni_diag] timeout after ${spawnTimeoutMs / 1000}s
`;
				try { proc.kill("SIGTERM"); } catch {}
				setTimeout(() => { try { if (!proc.killed) proc.kill("SIGKILL"); } catch {} }, 5_000);
			}, spawnTimeoutMs);

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
				clearTimeout(timeout);
				if (buffer.trim()) {
					try { const evt = JSON.parse(buffer.trim()); if (evt.type === "message_end" && evt.message) result.messages.push(evt.message); } 
					catch { /* ignore */ }
				}
				resolve(code ?? 0);
			});

			proc.on("error", (err) => { clearTimeout(timeout); result.stderr += `[omni_diag] spawn error: ${err.message}
`; resolve(1); });

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
	/** v2.7.0(F16): experts 强约束 minItems=1, maxItems=8 */
	experts: Type.Optional(Type.Array(ExpertTask, { description: "要调度的专家和任务列表。单专家传入1个，多专家并行传入2-8个。链式模式时可省略，改用 chain 参数。", minItems: 1, maxItems: 8 })),
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

		// v2.7.0(F5): 代码级输入净化 —— 检测危险注入模式
		const DANGEROUS_PATTERNS = [
			/(?:忽略|跳过|不用|不需要)(?:安全|所有|全部)(?:检查|审查|规则|要求)/,
			/(?:ignore|skip|bypass|disable)\s*(?:all|security|safety|checks?|rules?)/i,
			/(?:rm\s+-rf|sudo\s+|chmod\s+777|wget\s+.*\|\s*(?:ba)?sh)/i,
		];
		const allTasks = [...expertsList.map(e => e.task), ...chainList.map(s => s.task)];
		for (const task of allTasks) {
			for (const pat of DANGEROUS_PATTERNS) {
				if (pat.test(task)) {
					Diagnostics.warn(ctx.cwd, "input_sanitizer", `危险注入模式检测: "${task.slice(0, 100)}"`);
					return { content: [{ type: "text", text: `⛔ 输入净化阻断：专家任务中包含危险模式（安全绕过/命令注入）。请修正任务描述后重试。\n匹配模式: ${pat}\n任务片段: ${task.slice(0, 200)}` }] };
				}
			}
		}

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

			// v2.4.0(R2): 结构化输出强制要求 — 注入到每个专家任务
			// DEV-10 FIX: modelConfig 需在执行器作用域内初始化（此前仅在 runExpert() 中定义）
			const modelConfig = getModelConfig(process.env.OMNIPM_EXPERT_MODEL);
			const modelHint = modelConfig.model || "default";
			const ctxK = Math.round(modelConfig.contextWindow / 1000);
			const structuredOutputReq = [
				"\n\n## ⚠️ 结构化输出要求（v2.4.0 强制）",
				`你现在运行在 ${modelHint} 模型上，拥有 ${ctxK}K 上下文窗口。`,
				"你的输入只占一小部分，有充足空间进行深度分析。",
				"",
				"你必须按以下格式输出详细评审意见：",
				"1. **【思考过程】** ≥100字，详述你的分析逻辑和推理链",
				"2. **【严重等级】** 明确标注 P0(阻断)/P1(重要)/P2(建议)",
				"3. **【发现清单】** ≥5条，每条格式:",
				"   `[P0|P1|P2] [分类] 具体发现 → 详细修复建议（含代码示例）`",
				"4. **【逐项审查】** 按审查清单逐项标记 ✅/⚠️/❌，每项至少一句话说明",
				"5. **【协作提示】** 给其他专家的具体建议 ≥2条",
				"",
				"⚠️ 不要只给简短结论。对每个发现展开：问题是什么、为什么是问题、怎么修。",
			].join("\n");

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
					? `${et.task}${structuredOutputReq}\n\n## 评审材料\n\n${et.context}\n${intensityHints[intensity]}`
					: `${et.task}${structuredOutputReq}${intensityHints[intensity]}`;

				const result = await runExpert(ctx.cwd, agent, fullTask, signal, dagContextFile ?? undefined);
				const output = getFinalOutput(result.messages);
				const sev = parseSeverity(output);

				// v2.5.0: 专家输出质量评分（DEV-4.1）
				const qScore = scoreAndLogExpert(ctx.cwd, agent.name, et.task, output, intensity, result.stopReason);
				const qScoreLine = qScore ? ` | 质量: ${qScore.grade}(${qScore.total})` : "";

				return {
					content: [{
						type: "text",
						text: `${formatDAGSuggestionBlock(generateDAGSuggestion(params.nodeId ?? "single", [result], getCorrectionCount(ctx.cwd, params.nodeId)))}

## ${agent.name} 评审意见\n\n${output || "(no output)"}\n\n---\n*严重等级: ${sev || "未标注"}${qScoreLine} | ${formatUsage(result.usage, result.model, result.stopReason)} | 诊断: ${(() => { const d = diagnoseOutput(result.messages); return `文本${d.textBlocks}块/${d.textChars}字 工具调用${d.toolUseCount}次`; })()}*`,
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
					? `${et.task}${structuredOutputReq}\n\n## 评审材料\n\n${et.context}\n${intensityHints[intensity]}`
					: `${et.task}${structuredOutputReq}${intensityHints[intensity]}`;

				return await runExpert(ctx.cwd, agent, fullTask, signal, dagContextFile ?? undefined);
			});

			allResults.push(...results);

			// v2.5.0: 对所有并行结果进行质量评分并写入日志（DEV-4.1）
			for (const r of results) {
				if (r.exitCode === 0) {
					scoreAndLogExpert(ctx.cwd, r.expert, r.task, getFinalOutput(r.messages), intensity, r.stopReason);
				}
			}

			const successCount = results.filter(r => r.exitCode === 0).length;
			const summaries = results.map(r => {
				const output = getFinalOutput(r.messages);
				const sev = parseSeverity(output);
				const status = r.exitCode !== 0 ? "❌ 失败" : "✅ 完成";
				const capped = output.length > PER_EXPERT_OUTPUT_CAP
					? output.slice(0, PER_EXPERT_OUTPUT_CAP) + "\n\n[输出已截断]"
					: output;
				const d = diagnoseOutput(r.messages);
				return `### ${r.expert} ${status}\n\n${capped}\n\n*严重等级: ${sev || "未标注"} | ${formatUsage(r.usage, r.model, r.stopReason)} | 诊断: 文本${d.textBlocks}块/${d.textChars}字 工具调用${d.toolUseCount}次*`;
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
							dependsOn: n.dependsOn,
							correctionCount: 0,
						})),
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					};
					dagStates.set(cwd, state);
					saveDAGState(cwd, state);

					// P1-4: init 时预生成 DAG 上下文
					prepareDAGContextFile(cwd);
					// v2.5.0: 初始化 NEXT_SESSION_GUIDE.md 自动维护
					maintainNextSessionGuide(cwd, state);

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
						const gateList = unconfirmedGates.map(g => `  - ${g.nodeId}: ${g.name} [${g.status}]`).join("\n");
						return {
							content: [{
								type: "text",
								text: `⛔ 存在未确认的 GATE 门控节点，不允许启动新节点:
${gateList}

请先完成 GATE 确认：omni_dag complete(nodeId: "<gate_id>", confirmed: true)`,
							}],
						};
					}
					
					// v2.7.0(F11): 前置依赖检查 —— 验证全部 dependsOn 已完成
					if (node.dependsOn && node.dependsOn.length > 0) {
						const unmet = node.dependsOn.filter(depId => {
							const dep = state!.nodes.find(n => n.nodeId === depId);
							return !dep || dep.status !== "done";
						});
						if (unmet.length > 0) {
							const statusList = unmet.map(depId => {
								const dep = state!.nodes.find(n => n.nodeId === depId);
								return `  - ${depId}: ${dep?.name || "?"} [${dep?.status || "missing"}]`;
							}).join("\n");
							return {
								content: [{
									type: "text",
									text: `⛔ 前置依赖未满足，无法启动节点 "${node.name}":
${statusList}

已完成节点: ${state!.nodes.filter(n => n.status === "done").map(n => n.nodeId).join(", ") || "无"}`,
								}],
							};
						}
					}
					
					node.status = "running";
					node.startedAt = new Date().toISOString();
					state.currentNode = params.nodeId;
					state.updatedAt = new Date().toISOString();
					saveDAGState(cwd, state);

					// P1-4: 更新 DAG 上下文
					prepareDAGContextFile(cwd);
					// v2.5.0: 用户开始活跃工作 → 清除恢复提示
					clearRecoveryNotice(cwd);
					// v2.4.0: 事件发射
					emitDAGEvent("started", state, params.nodeId);
					
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
${missingFiles.map(f => `  - ${f}`).join("\n")}

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
					// v2.5.0: 自动维护 NEXT_SESSION_GUIDE.md
					maintainNextSessionGuide(cwd, state);
					// v2.4.0: 事件发射 + 复盘记录
					emitDAGEvent("completed", state, params.nodeId);
					// 全部节点完成时触发复盘
					if (state.nodes.every(n => n.status === "done")) {
						recordRetrospective(state);
					}
					
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
						// v2.5.0: 熔断时也更新引导词
						maintainNextSessionGuide(cwd, state);
						// v2.4.0: 熔断事件
						eventEmitter.emitCircuitBreaker({
							nodeId: params.nodeId!,
							nodeName: node.name,
							correctionCount: node.correctionCount,
							reason: `节点已连续修正${node.correctionCount}次`,
							timestamp: new Date().toISOString(),
						});
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
					// v2.5.0: 失败时更新引导词
					maintainNextSessionGuide(cwd, state);
					
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
					try { fs.unlinkSync(getDAGStatePath(cwd)); } catch { Diagnostics.warn(ctx.cwd, "dag_reset", "DAG状态文件清理失败"); }
					// P1-4: 清理 DAG 上下文 Markdown 文件
					try { fs.unlinkSync(getDAGMarkdownPath(cwd)); } catch { Diagnostics.warn(ctx.cwd, "dag_reset", "DAG上下文文件清理失败"); }
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
	// 工具 3: condition_branch — 可编程条件分支（v2.4.0）
	// --------------------------------------------------
	const branchRegistry = new Map<string, any>();

	pi.registerTool({
		name: "condition_branch",
		label: "Condition Branch",
		description: [
			"OmniPM v2.4.0 可编程条件分支工具。基于专家评审输出动态决定DAG下一步路径。",
			"操作: evaluate(评估分支)/register(注册规则)/list(列出规则)。",
			"条件: equals/contains/matches/gt/gte/lt/lte/in/exists/severity_is/severity_gte。",
			"预定义模板: securityReview(安全评审)/coverageGate(覆盖率门禁)。",
		].join(" "),
		parameters: Type.Object({
				action: Type.Enum({ register: "register", evaluate: "evaluate", list: "list" } as const, { default: "evaluate" as const }),
				branchId: Type.Optional(Type.String()),
				branch: Type.Optional(Type.Any()),
				expertResults: Type.Optional(Type.Any()),
			}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "register": {
					if (!params.branchId || !params.branch) {
						return { content: [{ type: "text", text: "register requires branchId and branch" }] };
					}
					branchRegistry.set(params.branchId, params.branch);
					return { content: [{ type: "text", text: `✅ 条件分支已注册: ${params.branchId}` }] };
				}
				case "evaluate": {
					if (!params.branchId) {
						return { content: [{ type: "text", text: "evaluate requires branchId" }] };
					}
					const branch = branchRegistry.get(params.branchId);
					if (!branch) {
						const available = Array.from(branchRegistry.keys()).join(", ") || "none";
						return { content: [{ type: "text", text: `Branch "${params.branchId}" not found. Registered: ${available}` }] };
					}
					const evaluator = new ConditionEvaluator();
					const dagState = dagStates.get(ctx.cwd);
					if (dagState) evaluator.setDAGState(dagState);
					if (params.expertResults) {
						for (const [name, result] of Object.entries(params.expertResults as Record<string, any>)) {
							evaluator.setExpertResult(name, result);
						}
					}
					const executor = new BranchExecutor(evaluator);
					const result = executor.execute(branch);
					return {
						content: [{
							type: "text",
							text: `## 条件分支: ${params.branchId}\n匹配: ${result.matchedCase ?? "(default)"}\n动作: ${result.action.type}\n原因: ${result.action.reason}`,
						}],
					};
				}
				case "list": {
					const entries = Array.from(branchRegistry.entries());
					if (entries.length === 0) return { content: [{ type: "text", text: "无已注册的条件分支。" }] };
					return { content: [{ type: "text", text: `已注册分支: ${entries.map(([id]) => id).join(", ")}` }] };
				}
				default:
					return { content: [{ type: "text", text: `Unknown action: ${params.action}` }] };
			}
		},

		renderCall(args, theme, _context) {
			return new Text(theme.fg("toolTitle", theme.bold("condition_branch ")) + theme.fg("accent", args.action || "?"), 0, 0);
		},

		renderResult(result, _expanded, theme, _context) {
			const text = result.content?.[0];
			return new Text(text?.type === "text" ? text.text.split("\n")[0] : "(no output)", 0, 0);
		},
	});

	// --------------------------------------------------
	// 工具 3: cdl_search — CDL 能力自发现（v2.4.0新增）
	// --------------------------------------------------
	pi.registerTool({
		name: "cdl_search",
		label: "CDL Search",
		description: [
			"OmniPM v2.4.0 CDL 能力自发现层。自动搜索 Pi 生态 + GitHub 生态可用能力。",
			"操作: detect(检测后端)/search(执行搜索)/qscore(质量评分)/status(查看状态)/cache_clean(清理缓存)。",
			"后端降级链: Exa语义搜索 → GitHub代码搜索 → agent-reach渠道检测 → 缓存 → 裸奔模式。",
		].join(" "),
		parameters: Type.Object({
			action: Type.Enum({ detect: "detect", search: "search", qscore: "qscore", status: "status", cache_clean: "cache_clean" } as const, { default: "detect" as const }),
			panorama: Type.Optional(Type.Any()),
			candidates: Type.Optional(Type.Array(Type.Any())),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const detector = new CDLDetector(ctx.cwd);
			const orchestrator = new CDLOrchestrator(ctx.cwd);
			const qscorer = new QScoreCalculator(ctx.cwd);

			switch (params.action) {
				case "detect": {
					const status = await detector.detectAll();
					const md = formatCDLStatusAsMarkdown(status);
					const gateBlock = formatCDLGateDesignBlock(status);
					return {
						content: [{ type: "text", text: md + "\n\n" + gateBlock }],
						details: { status },
					};
				}
				case "search": {
					if (!params.panorama) {
						return { content: [{ type: "text", text: "search requires panorama (ProjectPanorama) with techStack/functionalRequirements/constraints" }] };
					}
					const { results, status, degradationNote } = await orchestrator.search(params.panorama as any);
					const md = formatCDLStatusAsMarkdown(status);
					const resultLines = results.map((r: CDLSearchResult, i: number) =>
						`${i + 1}. [${r.source}] **${r.name}** — ${r.description?.slice(0, 120) || "无描述"}\n   ${r.url}`
					);
					const text = [
						`## CDL 搜索结果 (${results.length} 条)`,
						degradationNote ? `⚠️ ${degradationNote}` : "",
						"",
						...resultLines,
						"",
						md,
					].filter(Boolean).join("\n");
					return {
						content: [{ type: "text", text }],
						details: { results, status },
					};
				}
				case "qscore": {
					if (!params.candidates || params.candidates.length === 0) {
						return { content: [{ type: "text", text: "qscore requires candidates array" }] };
					}
					const evaluations = qscorer.evaluateAll(params.candidates as CDLSearchResult[]);
					const lines = evaluations.map((e, i) =>
						`${i + 1}. ${e.verdict === "auto" ? "🟢" : e.verdict === "manual" ? "🟡" : "🔴"} **${e.target}** Q=${e.qScore} — ${e.recommendation}`
					);
					return {
						content: [{ type: "text", text: `## Q-Score 评估结果\n\n${lines.join("\n")}` }],
						details: { evaluations },
					};
				}
				case "status": {
					// 返回缓存状态
					const cache = new CDLCache(ctx.cwd);
					const status = await detector.detectAll();
					const cleaned = cache.cleanExpired();
					const md = formatCDLStatusAsMarkdown(status);
					return {
						content: [{ type: "text", text: md + `\n\n🧹 清理过期缓存: ${cleaned} 条` }],
						details: { status, cleanedCached: cleaned },
					};
				}
				case "cache_clean": {
					const cache = new CDLCache(ctx.cwd);
					const cleaned = cache.cleanExpired();
					return {
						content: [{ type: "text", text: `🧹 CDL 缓存清理完成: ${cleaned} 条过期条目已删除。` }],
					};
				}
				default:
					return { content: [{ type: "text", text: `Unknown action: ${params.action}. Available: detect, search, qscore, status, cache_clean` }] };
			}
		},

		renderCall(args, theme, _context) {
			return new Text(theme.fg("toolTitle", theme.bold("cdl_search ")) + theme.fg("accent", args.action || "?"), 0, 0);
		},

		renderResult(result, _expanded, theme, _context) {
			const text = result.content?.[0];
			const firstLine = text?.type === "text" ? text.text.split("\n")[0] : "(no output)";
			return new Text(firstLine.slice(0, 80), 0, 0);
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
	// Session Hook: 注入 OmniPM 工具清单 + 重置降级状态 + DAG 恢复检测
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

		// v2.5.0: 检测未完成 DAG → 自动注入恢复提示到 NEXT_SESSION_GUIDE.md
		const dagState = loadDAGState(ctx.cwd);
		if (dagState) {
			const doneCount = dagState.nodes.filter(n => n.status === "done").length;
			const total = dagState.nodes.length;
			if (doneCount < total) {
				// 有未完成 DAG — 注入恢复提示
				injectRecoveryNotice(ctx.cwd, dagState);
				const pendingNodes = dagState.nodes.filter(n => n.status !== "done" && n.status !== "blocked");
				const blockedNodes = dagState.nodes.filter(n => n.status === "blocked");
				let hint = `DAG「${dagState.projectName}」进度 ${doneCount}/${total}`;
				if (pendingNodes.length > 0) hint += `，下一节点: ${pendingNodes[0].nodeId}`;
				if (blockedNodes.length > 0) hint += `，⚠️ ${blockedNodes.length} 个阻塞节点`;
				ctx.ui.notify(`🔄 ${hint}。恢复提示已注入 NEXT_SESSION_GUIDE.md`, "warning");
			} else {
				// DAG 已完成 — 清除可能残留的恢复提示
				clearRecoveryNotice(ctx.cwd);
			}
		}

		const discovery = discoverAgents(ctx.cwd, "omnipm");
		const expertNames = discovery.agents.map(a => a.name).join(", ");
		ctx.ui.notify(
			`OmniPM v2.5.0: ${discovery.agents.length} experts loaded (${expertNames})`,
			"info",
		);
	});

		// v2.4.0: 初始化事件总线 + 复盘引擎
	const eventEmitter = new OmniPMEventEmitter(pi.events);
	const retrospectiveEngine = createRetrospectiveEngine();
	const dagContextManager = new DAGContextManager();

	// v2.4.0: DAG状态变更 → 事件发射
	const emitDAGEvent = (eventType: string, dagState: DAGState, nodeId?: string) => {
		const node = nodeId ? dagState.nodes.find(n => n.nodeId === nodeId) : undefined;
		if (!node) return;
		if (eventType === "started") eventEmitter.emitNodeStarted(dagState, node);
		else if (eventType === "completed") eventEmitter.emitNodeCompleted(dagState, node);
		else if (eventType === "failed") eventEmitter.emitNodeFailed(dagState, node, "");
		dagContextManager.setState(dagState);
	};

	// v2.4.0: 复盘记录
	const recordRetrospective = (dagState: DAGState, projectType: string = "开发型") => {
		const record: ExecutionRecord = {
			projectName: dagState.projectName,
			projectType: projectType as any,
			templateName: "custom",
			executedAt: new Date().toISOString(),
			durationMinutes: 0,
			dagResult: {
				totalNodes: dagState.nodes.length,
				completedNodes: dagState.nodes.filter(n => n.status === "done").length,
				failedNodes: dagState.nodes.filter(n => n.status === "failed").length,
				blockedNodes: dagState.nodes.filter(n => n.status === "blocked").length,
				totalCorrections: dagState.nodes.reduce((s, n) => s + n.correctionCount, 0),
				avgCorrectionsPerNode: dagState.nodes.length > 0
					? dagState.nodes.reduce((s, n) => s + n.correctionCount, 0) / dagState.nodes.length : 0,
			},
			expertStats: [],
		};
		retrospectiveEngine.recordExecution(record);
		// 累积足够数据后自动分析
		if (retrospectiveEngine.export().records.length >= 3) {
			retrospectiveEngine.analyze();
		}
	};

	console.log("OmniPM Orion Extension v2.5.0 loaded. Tools: run_experts(single/parallel/chain), omni_dag, condition_branch; v2.5.0: NSG Auto-Maintenance (DEV-7) + Events Bus + Condition Branch + Enhanced DAG Context + Retrospective Engine");
}
