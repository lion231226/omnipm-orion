/**
 * OmniPM v2.2.1 — DAG 工具函数（平台无关纯函数）
 * 
 * 从 index.ts 提取的可测试核心逻辑。
 * 不依赖任何平台 API、文件系统、网络。
 */

import type { DAGSuggestion, DAGNode, DAGState, ExpertResult } from "./interface.ts";

// ============================================================
// 常量
// ============================================================

export const MAX_CORRECTIONS_PER_NODE = 3;
export const MAX_PARALLEL_EXPERTS = 8;

// ============================================================
// 严重等级解析
// ============================================================

export function parseSeverity(output: string): "P0" | "P1" | "P2" | undefined {
  const p0 = output.match(/P0[-\s]*阻塞/i) || output.match(/严重等级[：:]\s*P0/i);
  if (p0) return "P0";
  const p1 = output.match(/P1[-\s]*重要/i) || output.match(/严重等级[：:]\s*P1/i);
  if (p1) return "P1";
  const p2 = output.match(/P2[-\s]*建议/i) || output.match(/严重等级[：:]\s*P2/i);
  if (p2) return "P2";
  return undefined;
}

// ============================================================
// 输出提取
// ============================================================

import type { Message } from "./interface.ts";

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text ?? "";
      }
    }
  }
  return "";
}

// ============================================================
// DAG 建议生成 ★ v2.2.1: 新增空输出检测
// ============================================================

export function generateDAGSuggestion(
  nodeId: string,
  results: ExpertResult[],
  correctionCount: number,
  /** v2.2.1: 外部文件验证器（可选注入，便于测试） */
  fileExists?: (path: string) => boolean,
): DAGSuggestion {
  // 文件验证（需要外部注入 fs 能力）
  if (fileExists) {
    const allClaimed = results.flatMap(r => r.claimed_files ?? []);
    if (allClaimed.length > 0) {
      const missing = allClaimed.filter(f => !fileExists(f));
      if (missing.length > 0) {
        return {
          action: "retry",
          nodeId,
          reason: `声称写入${missing.length}个文件但不存在`,
          severity: "P0",
          correctionCount,
        };
      }
    }
  }

  // 熔断检查
  if (correctionCount >= MAX_CORRECTIONS_PER_NODE) {
    return {
      action: "blocked",
      nodeId,
      reason: `节点已修正 ${correctionCount} 次，达到熔断阈值`,
      severity: "P0",
      correctionCount,
    };
  }

  // v2.2.1: 空输出检测（子进程正常退出但无任何消息）
  const hasEmptyOutput = results.some(
    r => r.exitCode === 0 && getFinalOutput(r.messages).trim().length === 0,
  );
  if (hasEmptyOutput) {
    return {
      action: "retry",
      nodeId,
      reason: "专家无输出（空响应）",
      severity: "P0",
      correctionCount,
    };
  }

  // 进程失败检测
  const hasFailure = results.some(r => r.exitCode !== 0);
  if (hasFailure) {
    return {
      action: "retry",
      nodeId,
      reason: "专家执行失败",
      severity: "P0",
      correctionCount,
    };
  }

  // 质量检测
  const hasP0 = results.some(r => r.severity === "P0");
  const hasP1 = results.some(r => r.severity === "P1");

  if (hasP0) {
    return {
      action: "retry",
      nodeId,
      reason: "发现P0阻塞项，需修正后重审",
      severity: "P0",
      correctionCount,
    };
  }

  if (hasP1) {
    return {
      action: "retry",
      nodeId,
      reason: "发现P1重要问题，建议修正后重审",
      severity: "P1",
      correctionCount,
    };
  }

  return {
    action: "complete",
    nodeId,
    reason: `全部${results.length}位专家通过`,
    severity: "P2",
    correctionCount,
  };
}

// ============================================================
// DAG 状态查询
// ============================================================

export function getNodeById(state: DAGState, nodeId: string): DAGNode | undefined {
  return state.nodes.find(n => n.nodeId === nodeId);
}

export function getReadyNodes(state: DAGState): DAGNode[] {
  return state.nodes.filter(n => {
    if (n.status !== "pending") return false;
    return n.dependsOn.every(depId => {
      const dep = state.nodes.find(d => d.nodeId === depId);
      return dep?.status === "done";
    });
  });
}

export function getNodesByStatus(state: DAGState, status: DAGNode["status"]): DAGNode[] {
  return state.nodes.filter(n => n.status === status);
}

export function getDAGProgress(state: DAGState): { done: number; total: number; pct: number } {
  const total = state.nodes.length;
  const done = state.nodes.filter(n => n.status === "done").length;
  return { done, total, pct: total > 0 ? Math.round(done / total * 100) : 0 };
}

// ============================================================
// DAG 结构验证
// ============================================================

export function validateDAGTopology(nodes: DAGNode[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const nodeIds = new Set(nodes.map(n => n.nodeId));

  // 检查孤立依赖
  for (const node of nodes) {
    for (const depId of node.dependsOn) {
      if (!nodeIds.has(depId)) {
        errors.push(`节点 "${node.nodeId}" 依赖不存在的节点 "${depId}"`);
      }
    }
  }

  // 检查循环依赖（Kahn 算法）
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    inDegree.set(n.nodeId, n.dependsOn.length);
    adj.set(n.nodeId, []);
  }
  for (const n of nodes) {
    for (const depId of n.dependsOn) {
      adj.get(depId)?.push(n.nodeId);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited++;
    for (const neighbor of adj.get(current) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (visited !== nodes.length) {
    errors.push("DAG 存在循环依赖");
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================
// 熔断检查
// ============================================================

export function checkCircuitBreaker(
  node: DAGNode,
  correctionCount: number,
): { blocked: boolean; reason?: string } {
  if (correctionCount >= MAX_CORRECTIONS_PER_NODE) {
    return {
      blocked: true,
      reason: `节点 "${node.name}" 已连续修正 ${correctionCount} 次，达到熔断阈值。建议：(A) 人工介入 (B) 回退上级节点 (C) 标记已知限制`,
    };
  }
  return { blocked: false };
}

// ============================================================
// 平台提示词配置验证
// ============================================================

import { PLATFORM_PROMPT_CONFIGS, type PlatformPromptConfig } from "./interface.ts";

export function getPlatformConfig(platform: string): PlatformPromptConfig {
  return PLATFORM_PROMPT_CONFIGS[platform as keyof typeof PLATFORM_PROMPT_CONFIGS]
    ?? PLATFORM_PROMPT_CONFIGS.unknown;
}

export function validatePlatformConfig(config: PlatformPromptConfig): string[] {
  const issues: string[] = [];
  if (!config.toolCallFormat) issues.push("缺少 toolCallFormat");
  if (!config.gateTemplate) issues.push("缺少 gateTemplate");
  if (!config.subagentInstructions) issues.push("缺少 subagentInstructions");
  return issues;
}
