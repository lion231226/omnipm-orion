/**
 * OmniPM v2.4.0 — DAG 上下文自动注入增强（P1-4）
 * 
 * 在 v2.1.0 P1-4 基础上增强：
 * 1. 上游节点摘要自动收集（跨节点上下文传递）
 * 2. 事件驱动的上下文刷新（N4 事件总线集成）
 * 3. 专家强度感知的上下文裁剪（DEEP更全，LIGHT更精简）
 * 4. 子代理 before_agent_start 钩子自动注入
 */

import type { DAGState, DAGNode, RuntimeContext } from "./interface.ts";
import { OmniPMEvents } from "./events.ts";

// ============================================================
// 上游摘要
// ============================================================

export interface UpstreamSummary {
  nodeId: string;
  nodeName: string;
  nodeType?: string;
  completedAt: string;
  /** 关键决策（≤3条） */
  keyDecisions: string[];
  /** 产出文件列表 */
  outputFiles: string[];
  /** 严重等级（该节点评审结果） */
  severity?: "P0" | "P1" | "P2";
}

// ============================================================
// 上下文构建器
// ============================================================

export interface DAGInjectionConfig {
  /** 注入强度 */
  intensity: "MINIMAL" | "STANDARD" | "FULL";
  /** 是否包含上游摘要 */
  includeUpstreamSummaries: boolean;
  /** 是否包含完整 DAG 拓扑 */
  includeFullTopology: boolean;
  /** 上游摘要最大深度（跳数） */
  maxUpstreamDepth: number;
  /** 每个上游节点摘要最大长度 */
  maxSummaryLength: number;
}

const DEFAULT_CONFIG: DAGInjectionConfig = {
  intensity: "STANDARD",
  includeUpstreamSummaries: true,
  includeFullTopology: false,
  maxUpstreamDepth: 3,
  maxSummaryLength: 500,
};

/**
 * 根据专家调用强度获取注入配置
 */
export function getInjectionConfig(
  intensity: "LIGHT" | "STANDARD" | "DEEP" | "PAIR" | undefined,
): DAGInjectionConfig {
  switch (intensity) {
    case "LIGHT":
      return {
        ...DEFAULT_CONFIG,
        intensity: "MINIMAL",
        includeUpstreamSummaries: false,
        maxUpstreamDepth: 1,
      };
    case "DEEP":
    case "PAIR":
      return {
        ...DEFAULT_CONFIG,
        intensity: "FULL",
        includeFullTopology: true,
        maxUpstreamDepth: 5,
        maxSummaryLength: 1000,
      };
    default:
      return DEFAULT_CONFIG;
  }
}

// ============================================================
// 上游摘要收集
// ============================================================

export function collectUpstreamSummaries(
  state: DAGState,
  currentNodeId: string,
  maxDepth: number = 3,
): UpstreamSummary[] {
  const nodeMap = new Map(state.nodes.map(n => [n.nodeId, n]));
  const currentNode = nodeMap.get(currentNodeId);
  if (!currentNode) return [];

  const summaries: UpstreamSummary[] = [];
  const visited = new Set<string>();

  // BFS 从当前节点向上游遍历
  const queue: Array<{ nodeId: string; depth: number }> = [];
  for (const depId of currentNode.dependsOn) {
    queue.push({ nodeId: depId, depth: 1 });
  }

  while (queue.length > 0) {
    const { nodeId, depth } = queue.shift()!;
    if (visited.has(nodeId) || depth > maxDepth) continue;
    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) continue;

    if (node.status === "done" && node.outputs) {
      summaries.push({
        nodeId: node.nodeId,
        nodeName: node.name,
        nodeType: node.nodeType,
        completedAt: node.completedAt ?? "",
        keyDecisions: node.outputs.keyDecisions ?? [],
        outputFiles: node.outputs.files ?? [],
      });
    }

    // 继续向上游
    for (const depId of node.dependsOn) {
      queue.push({ nodeId: depId, depth: depth + 1 });
    }
  }

  return summaries;
}

// ============================================================
// DAG 上下文 Markdown 生成（增强版）
// ============================================================

export function buildEnhancedDAGMarkdown(
  state: DAGState,
  currentNodeId: string | undefined,
  config: DAGInjectionConfig = DEFAULT_CONFIG,
): string {
  const lines: string[] = [
    `# DAG Execution Context (v2.4.0)`,
    ``,
    `> Auto-injected by OmniPM Extension P1-4 (Enhanced).`,
    `> Provides expert with current DAG execution status and upstream summaries.`,
    ``,
  ];

  // 基本信息
  const doneCount = state.nodes.filter(n => n.status === "done").length;
  const totalCount = state.nodes.length;
  const progress = totalCount > 0 ? Math.round(doneCount / totalCount * 100) : 0;

  lines.push(`## 📊 Project: ${state.projectName}`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Progress | ${doneCount}/${totalCount} (${progress}%) |`);
  lines.push(`| Current Node | ${currentNodeId ?? "N/A"} |`);
  lines.push(``);

  // 全拓扑（仅 FULL 模式）
  if (config.includeFullTopology) {
    lines.push(`## 🗺️ Full DAG Topology`);
    lines.push(``);
    const statusIcons: Record<string, string> = {
      done: "✅", running: "🔄", failed: "❌", blocked: "🚨",
      pending: "⬜", awaiting_gate: "⏸️",
    };
    for (const node of state.nodes) {
      const icon = statusIcons[node.status] ?? "❓";
      const deps = node.dependsOn.length > 0 ? ` ← ${node.dependsOn.join(", ")}` : "";
      lines.push(`- ${icon} **${node.nodeId}**: ${node.name}${deps}`);
    }
    lines.push(``);
  }

  // 已完成节点
  const completedNodes = state.nodes.filter(n => n.status === "done");
  if (completedNodes.length > 0) {
    lines.push(`## ✅ Completed Nodes (${completedNodes.length})`);
    for (const n of completedNodes) {
      lines.push(`- ${n.nodeId}: ${n.name}`);
    }
    lines.push(``);
  }

  // 失败/阻塞节点
  const failedNodes = state.nodes.filter(n => n.status === "failed" || n.status === "blocked");
  if (failedNodes.length > 0) {
    lines.push(`## ❌ Failed / Blocked Nodes`);
    for (const n of failedNodes) {
      const icon = n.status === "blocked" ? "🚨" : "❌";
      lines.push(`- ${icon} ${n.nodeId}: ${n.name} (corrections: ${n.correctionCount})`);
    }
    lines.push(``);
  }

  // 上游摘要（增强特性）
  if (config.includeUpstreamSummaries && currentNodeId) {
    const summaries = collectUpstreamSummaries(state, currentNodeId, config.maxUpstreamDepth);
    if (summaries.length > 0) {
      lines.push(`## 📋 Upstream Node Summaries`);
      lines.push(``);
      for (const s of summaries) {
        const summary = formatUpstreamSummary(s, config.maxSummaryLength);
        lines.push(summary);
      }
    }
  }

  lines.push(`---`);
  lines.push(`*Generated at ${new Date().toISOString()} | Intensity: ${config.intensity}*`);

  return lines.join("\n");
}

function formatUpstreamSummary(s: UpstreamSummary, maxLen: number): string {
  const parts: string[] = [
    `### ${s.nodeId}: ${s.nodeName}`,
    `- **Type**: ${s.nodeType ?? "N/A"} | **Completed**: ${s.completedAt.slice(0, 10)}`,
  ];

  if (s.keyDecisions.length > 0) {
    parts.push(`- **Key Decisions**:`);
    for (const d of s.keyDecisions.slice(0, 3)) {
      const truncated = d.length > maxLen ? d.slice(0, maxLen) + "..." : d;
      parts.push(`  - ${truncated}`);
    }
  }

  if (s.outputFiles.length > 0) {
    const files = s.outputFiles.slice(0, 5).join(", ");
    parts.push(`- **Output Files**: ${files}${s.outputFiles.length > 5 ? ` (+${s.outputFiles.length - 5} more)` : ""}`);
  }

  parts.push(``);
  return parts.join("\n");
}

// ============================================================
// 事件驱动的上下文管理器
// ============================================================

export class DAGContextManager {
  private state: DAGState | null = null;
  private currentNodeId: string | undefined;
  private config: DAGInjectionConfig = DEFAULT_CONFIG;
  private lastMarkdown: string = "";

  constructor(state?: DAGState) {
    if (state) this.state = state;
  }

  setState(state: DAGState): void {
    this.state = state;
  }

  setCurrentNode(nodeId: string): void {
    this.currentNodeId = nodeId;
  }

  setConfig(config: Partial<DAGInjectionConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 构建当前上下文 Markdown
   */
  buildContext(): string {
    if (!this.state) {
      return "# DAG Execution Context\n\n> No active DAG.\n";
    }
    this.lastMarkdown = buildEnhancedDAGMarkdown(
      this.state,
      this.currentNodeId,
      this.config,
    );
    return this.lastMarkdown;
  }

  /**
   * 获取最新构建的上下文
   */
  getLastContext(): string {
    return this.lastMarkdown;
  }

  /**
   * 为特定节点构建上下文（含深度控制）
   */
  buildContextForNode(nodeId: string, depth: number = 3): string {
    if (!this.state) return "";
    return buildEnhancedDAGMarkdown(this.state, nodeId, {
      ...this.config,
      maxUpstreamDepth: depth,
    });
  }

  /**
   * 注入到系统提示词末尾（供 before_agent_start 钩子使用）
   */
  injectToSystemPrompt(baseSystemPrompt: string): string {
    const context = this.buildContext();
    if (!context || context.includes("No active DAG")) {
      return baseSystemPrompt;
    }
    return `${baseSystemPrompt}\n\n---\n\n${context}`;
  }
}

// ============================================================
// 子代理 DAG 上下文工厂
// ============================================================

export function createDAGContextForExpert(
  state: DAGState,
  currentNodeId: string,
  expertIntensity?: "LIGHT" | "STANDARD" | "DEEP" | "PAIR",
): string {
  const config = getInjectionConfig(expertIntensity);
  return buildEnhancedDAGMarkdown(state, currentNodeId, config);
}
