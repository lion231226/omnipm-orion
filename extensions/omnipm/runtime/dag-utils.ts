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

/** v2.3.1(D-2): 拼接所有 assistant 文本消息，而非仅取最后一条。
 *  确保多轮分析（读文件→分析→再读→分析）的中间产出不丢失。 */
export function getFinalOutput(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text" && part.text?.trim()) {
          parts.push(part.text.trim());
        }
      }
    }
  }
  if (parts.length === 0) return "";
  return parts.length === 1 ? parts[0] : parts.join("\n\n---\n\n");
}

// ============================================================
// v2.3.1(D-2): 输出截断检测
// ============================================================

/** 检测子代理输出是否被截断。
 *  检查 stopReason=max_tokens 及输出末尾是否残缺（未闭合的代码块、截断的句子等）。 */
export function isOutputTruncated(result: ExpertResult): boolean {
  // 条件1: stopReason 显式指示 max_tokens 截断
  if (result.stopReason === "max_tokens" || result.stopReason === "token_limit") {
    return true;
  }
  // 条件2: 输出末尾启发式截断检测
  const output = getFinalOutput(result.messages);
  if (output.length < 50) return false;

  // 检查未闭合的 markdown 代码块
  const fenceCount = (output.match(/```/g) || []).length;
  if (fenceCount % 2 !== 0) return true;

  // 检查结尾是否为截断模式
  const lastChars = output.slice(-20).trim();
  const truncationPatterns = [
    /[，,、]$/,
    /[（(]$/,
    /[:：]$/,
    /["'][^"']*$/,
    /\[未完成/,
  ];
  for (const pat of truncationPatterns) {
    if (pat.test(lastChars)) return true;
  }

  return false;
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
    const allClaimed = results.flatMap(r => r.claimedFiles ?? []);
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

  // v2.3.1(D-2): 检测输出截断（stopReason=max_tokens 或输出末尾残缺）
  const hasTruncated = results.some(r => isOutputTruncated(r));
  if (hasTruncated) {
    const names = results.filter(r => isOutputTruncated(r)).map(r => r.expert).join(", ");
    return {
      action: "retry",
      nodeId,
      reason: `${names} 输出疑似截断（stopReason=max_tokens）`,
      severity: "P1",
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

// ============================================================
// v2.5.0: 专家输出质量评分系统（DEV-4.1）
// ============================================================

/** 专家输出质量维度评分 */
export interface ExpertQualityScore {
  /** 综合得分 0-100 */
  total: number;
  /** 各维度得分 */
  dimensions: {
    /** 结构化符合度 (0-40): 输出是否匹配声明的格式 */
    structure: number;
    /** 建议完整性 (0-30): 至少3条建议 + 严重等级 */
    completeness: number;
    /** 专业深度 (0-20): 输出长度/领域术语/具体性 */
    depth: number;
    /** 可执行性 (0-10): 建议是否具体可操作 */
    actionability: number;
  };
  /** 质量评级 */
  grade: "A" | "B" | "C" | "D" | "F";
  /** 发现的问题 */
  issues: string[];
  /** 评分时间戳 */
  scoredAt: string;
}

/** 专家质量评分输入 */
export interface ExpertQualityInput {
  expert: string;
  task: string;
  output: string;
  intensity?: "LIGHT" | "STANDARD" | "DEEP" | "PAIR";
  stopReason?: string;
}

/** 质量评分阈值 */
const QUALITY_THRESHOLDS = {
  A: 85,
  B: 70,
  C: 55,
  D: 40,
} as const;

/** 各专家期望的 Markdown 节标题关键词 */
const EXPERT_SECTION_EXPECTATIONS: Record<string, string[]> = {
  architect: ["思考过程", "架构评估", "建议", "严重等级"],
  security: ["思考过程", "威胁模型", "安全检查", "建议", "严重等级"],
  backend: ["思考过程", "代码审查", "建议", "严重等级"],
  frontend: ["思考过程", "组件", "性能", "建议", "严重等级"],
  database: ["思考过程", "数据模型", "查询", "建议", "严重等级"],
  qa: ["思考过程", "测试策略", "测试场景", "建议", "严重等级"],
  devops: ["思考过程", "部署", "CI/CD", "建议", "严重等级"],
  requirements: ["思考过程", "需求分析", "优先级", "建议", "严重等级"],
  "course-designer": ["思考过程", "教学设计", "评估", "建议", "严重等级"],
  "content-reviewer": ["思考过程", "内容审查", "建议", "严重等级"],
  "market-analyst": ["思考过程", "市场分析", "数据", "建议", "严重等级"],
  "seo-expert": ["思考过程", "SEO", "关键词", "建议", "严重等级"],
  "media-producer": ["思考过程", "媒体", "制作", "建议", "严重等级"],
};

/**
 * 对专家输出进行质量评分
 * 纯函数，无副作用，可独立测试
 */
export function scoreExpertQuality(input: ExpertQualityInput): ExpertQualityScore {
  const { expert, output, intensity, stopReason } = input;
  const issues: string[] = [];

  // 维度 1: 结构化符合度 (0-40)
  const structureScore = scoreStructure(expert, output, intensity);
  if (structureScore < 30) issues.push("输出结构不完整，缺少期望的评估节");

  // 维度 2: 建议完整性 (0-30)
  const completenessScore = scoreCompleteness(output, stopReason);
  if (completenessScore < 20) issues.push("建议数量不足或缺少严重等级标记");

  // 维度 3: 专业深度 (0-20)
  const depthScore = scoreDepth(output, intensity);
  if (depthScore < 10) issues.push("输出过于简短，缺乏专业分析深度");

  // 维度 4: 可执行性 (0-10)
  const actionabilityScore = scoreActionability(output);
  if (actionabilityScore < 5) issues.push("建议过于笼统，缺乏具体可操作步骤");

  const total = structureScore + completenessScore + depthScore + actionabilityScore;

  let grade: ExpertQualityScore["grade"];
  if (total >= QUALITY_THRESHOLDS.A) grade = "A";
  else if (total >= QUALITY_THRESHOLDS.B) grade = "B";
  else if (total >= QUALITY_THRESHOLDS.C) grade = "C";
  else if (total >= QUALITY_THRESHOLDS.D) grade = "D";
  else grade = "F";

  return {
    total: Math.min(100, total),
    dimensions: {
      structure: structureScore,
      completeness: completenessScore,
      depth: depthScore,
      actionability: actionabilityScore,
    },
    grade,
    issues,
    scoredAt: new Date().toISOString(),
  };
}

/** 评估结构化符合度 (0-40) */
function scoreStructure(expert: string, output: string, intensity?: string): number {
  const expected = EXPERT_SECTION_EXPECTATIONS[expert];

  // 无预设期望 → 通用检查
  const sections = expected || ["思考过程", "评估", "建议", "严重等级"];

  let found = 0;
  for (const keyword of sections) {
    if (output.includes(keyword)) found++;
  }

  const ratio = found / sections.length;

  // 基础分 = 匹配比例 × 30
  let score = Math.round(ratio * 30);

  // 有 Markdown 标题结构加分
  if (output.includes("### ") || output.includes("## ")) score += 5;
  // 有表格加分
  if (output.includes("|") && output.includes("---")) score += 3;
  // 有代码块加分
  if (output.includes("```")) score += 2;

  // 强度修正
  if (intensity === "LIGHT") score = Math.min(30, score); // 轻量模式期望降低

  return Math.min(40, score);
}

/** 评估建议完整性 (0-30) */
function scoreCompleteness(output: string, stopReason?: string): number {
  let score = 0;

  // 严重等级检测
  const hasSeverity = /P[012]/.test(output);
  if (hasSeverity) score += 10;

  // 建议数量检测（匹配 "1." / "- **" / "【" 等编号模式）
  const findingMatches = output.match(/(?:^|\n)\s*(?:\d+\.|[-•]\s*\*\*|【)/gm);
  const findingCount = findingMatches ? findingMatches.length : 0;
  if (findingCount >= 5) score += 12;
  else if (findingCount >= 3) score += 8;
  else if (findingCount >= 1) score += 4;

  // 有风险/影响描述
  if (/风险|影响|后果|导致|危害/i.test(output)) score += 5;

  // 截断惩罚
  if (stopReason === "max_tokens" || stopReason === "token_limit") {
    score = Math.max(0, score - 8);
  }

  // 空输出惩罚
  if (output.trim().length < 50) score = 0;

  return Math.min(30, score);
}

/** 评估专业深度 (0-20) */
function scoreDepth(output: string, intensity?: string): number {
  const len = output.length;

  // 长度评分
  let score = 0;
  if (len > 3000) score = 10;
  else if (len > 1500) score = 7;
  else if (len > 500) score = 4;
  else if (len > 100) score = 2;
  else score = 0;

  // 领域术语密度
  const technicalTerms = [
    "架构", "模式", "耦合", "内聚", "扩展性", "性能", "安全", "加密",
    "注入", "认证", "授权", "SQL", "NoSQL", "缓存", "队列", "分布式",
    "一致性", "可用性", "分区", "微服务", "API", "协议", "schema",
    "索引", "查询优化", "事务", "隔离", "幂等", "降级", "熔断",
    "测试", "覆盖率", "集成", "E2E", "CI/CD", "部署", "容器",
    "威胁", "攻击", "漏洞", "合规", "审计", "加密", "TLS", "OAuth",
  ];
  let termCount = 0;
  for (const term of technicalTerms) {
    if (output.includes(term)) termCount++;
  }
  if (termCount >= 10) score += 8;
  else if (termCount >= 5) score += 5;
  else if (termCount >= 2) score += 2;

  // 有具体代码示例或配置
  if (/```[\s\S]{20,}```/.test(output)) score += 2;

  // 强度修正
  if (intensity === "LIGHT") score = Math.round(score * 0.5);
  if (intensity === "DEEP") score = Math.min(20, score + 2);

  return Math.min(20, score);
}

/** 评估可执行性 (0-10) */
function scoreActionability(output: string): number {
  let score = 0;

  // 具体建议模式：包含"建议"+"因为"或"示例"
  if (/(?:建议|推荐|应当|需要).{0,30}(?:因为|由于|示例|例如|比如)/i.test(output)) score += 4;

  // 包含优先级或时间估计
  if (/(?:优先|紧急|短期|中期|长期|低|中|高)/i.test(output)) score += 2;

  // 包含具体的工具/库/命令名称
  if (/(?:使用|引入|安装|配置|设置)[^.。\n]{0,50}(?:npm|pip|cargo|docker|k8s|nginx|redis|postgres|mysql)/i.test(output)) {
    score += 2;
  }

  // 包含量化指标
  if (/(?:\d+%|\d+ms|\d+ QPS|\d+ TPS|[<>]=?\s*\d+|目标.{0,10}\d+)/i.test(output)) score += 2;

  return Math.min(10, score);
}

/**
 * 批量评分并生成汇总报告
 */
export function aggregateQualityScores(scores: ExpertQualityScore[]): {
  average: number;
  gradeDistribution: Record<string, number>;
  worstDimension: string;
  expertAverages: Record<string, { avg: number; count: number }>;
} {
  if (scores.length === 0) {
    return { average: 0, gradeDistribution: {}, worstDimension: "", expertAverages: {} };
  }

  const avg = Math.round(scores.reduce((s, c) => s + c.total, 0) / scores.length);

  const gradeDist: Record<string, number> = {};
  for (const s of scores) {
    gradeDist[s.grade] = (gradeDist[s.grade] || 0) + 1;
  }

  // 找出平均分最低的维度
  const dimAvgs = {
    structure: Math.round(scores.reduce((s, c) => s + c.dimensions.structure, 0) / scores.length),
    completeness: Math.round(scores.reduce((s, c) => s + c.dimensions.completeness, 0) / scores.length),
    depth: Math.round(scores.reduce((s, c) => s + c.dimensions.depth, 0) / scores.length),
    actionability: Math.round(scores.reduce((s, c) => s + c.dimensions.actionability, 0) / scores.length),
  };
  const worst = Object.entries(dimAvgs).sort((a, b) => a[1] - b[1])[0][0];

  // 此处 expertAverages 需要在调用侧根据 expert 名分组后传入
  const expertAvgs: Record<string, { avg: number; count: number }> = {};

  return { average: avg, gradeDistribution: gradeDist, worstDimension: worst, expertAverages: expertAvgs };
}
