/**
 * OmniPM v2.4.0 — 项目复盘自动学习引擎
 * 
 * P2-4: 基于历史 DAG 执行数据优化模板和专家调度策略。
 * 
 * 核心机制:
 * 1. 每次 DAG 执行完成后，收集执行指标
 * 2. 定期分析历史数据，识别模式
 * 3. 自动优化：模板权重调整、专家强度建议、瓶颈预警
 */

import type { DAGState, DAGNode } from "./interface.ts";

// ============================================================
// 执行记录
// ============================================================

export interface ExecutionRecord {
  /** 项目名称 */
  projectName: string;
  /** 项目类型 */
  projectType: "开发型" | "课程型" | "方案型" | "图文型" | "音视频型";
  /** 使用的 DAG 模板 */
  templateName: string;
  /** 执行时间 */
  executedAt: string;
  /** 总耗时（分钟，估算） */
  durationMinutes: number;
  /** DAG 执行结果 */
  dagResult: {
    totalNodes: number;
    completedNodes: number;
    failedNodes: number;
    blockedNodes: number;
    totalCorrections: number;
    avgCorrectionsPerNode: number;
  };
  /** 专家调用统计 */
  expertStats: ExpertExecutionStat[];
  /** 用户满意度（1-5，如有） */
  userRating?: number;
  /** 备注 */
  notes?: string;
}

export interface ExpertExecutionStat {
  expert: string;
  called: number;
  avgSeverity: "P0" | "P1" | "P2" | "NONE";
  avgTokensUsed: number;
  successRate: number;   // 0-1
  avgDurationMs: number;
}

// ============================================================
// 学习存储
// ============================================================

export interface LearningStore {
  version: string;
  records: ExecutionRecord[];
  insights: LearningInsight[];
  updatedAt: string;
}

export interface LearningInsight {
  id: string;
  type: "template_optimization" | "expert_scheduling" | "bottleneck_warning" | "quality_trend";
  description: string;
  confidence: number;     // 0-1
  evidence: string[];     // 引用的 record 索引
  recommendation: string;
  applied: boolean;
  createdAt: string;
}

// ============================================================
// 学习引擎
// ============================================================

export class RetrospectiveEngine {
  private store: LearningStore;

  constructor(existingStore?: LearningStore) {
    this.store = existingStore ?? {
      version: "2.4.0",
      records: [],
      insights: [],
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * 记录一次 DAG 执行
   */
  recordExecution(record: ExecutionRecord): void {
    this.store.records.push(record);
    this.store.updatedAt = new Date().toISOString();

    // 自动裁剪：保留最近 50 条记录
    if (this.store.records.length > 50) {
      this.store.records = this.store.records.slice(-50);
    }
  }

  /**
   * 分析历史数据，生成优化洞察
   */
  analyze(): LearningInsight[] {
    const newInsights: LearningInsight[] = [];
    const records = this.store.records;

    if (records.length < 3) {
      return []; // 数据不足，跳过分析
    }

    // 1. 模板优化：识别高修正率模板
    const templateStats = this.groupByTemplate(records);
    for (const [template, recs] of Object.entries(templateStats)) {
      const avgCorrections = recs.reduce((sum, r) => sum + r.dagResult.avgCorrectionsPerNode, 0) / recs.length;
      if (avgCorrections > 1.5) {
        newInsights.push({
          id: `INS-${Date.now()}-T${template}`,
          type: "template_optimization",
          description: `模板 "${template}" 平均每节点修正 ${avgCorrections.toFixed(1)} 次，高于阈值(1.5)`,
          confidence: Math.min(0.9, recs.length / 10),
          evidence: recs.map(r => r.projectName),
          recommendation: "建议审查该模板的节点定义和专家配置，可能需要增加前置 REVIEW 节点",
          applied: false,
          createdAt: new Date().toISOString(),
        });
      }
    }

    // 2. 专家调度：识别低成功率专家
    const expertStats = this.groupByExpert(records);
    for (const [expert, stats] of Object.entries(expertStats)) {
      if (stats.count >= 3 && stats.avgSuccessRate < 0.7) {
        newInsights.push({
          id: `INS-${Date.now()}-E${expert}`,
          type: "expert_scheduling",
          description: `专家 "${expert}" 平均成功率 ${(stats.avgSuccessRate * 100).toFixed(0)}%，低于阈值(70%)`,
          confidence: Math.min(0.9, stats.count / 10),
          evidence: stats.projects,
          recommendation: `建议：1) 增加 ${expert} 的任务明确度 2) 考虑使用 DEEP 强度替代 STANDARD`,
          applied: false,
          createdAt: new Date().toISOString(),
        });
      }
    }

    // 3. 瓶颈预警：识别常阻塞节点
    const blockedNodes = this.findFrequentBlockedNodes(records);
    for (const node of blockedNodes) {
      newInsights.push({
        id: `INS-${Date.now()}-B${node.nodeType}`,
        type: "bottleneck_warning",
        description: `节点类型 "${node.nodeType}" 在 ${node.count} 次执行中阻塞，常见原因: ${node.commonReason}`,
        confidence: Math.min(0.85, node.count / 5),
        evidence: node.projects,
        recommendation: "建议在该类型节点前增加前置验证步骤或降低复杂度",
        applied: false,
        createdAt: new Date().toISOString(),
      });
    }

    this.store.insights.push(...newInsights);
    this.store.updatedAt = new Date().toISOString();

    return newInsights;
  }

  /**
   * 获取模板优化建议（供 Meta-Orion 使用）
   */
  getTemplateSuggestions(templateName: string): {
    suggestedIntensity: Record<string, "LIGHT" | "STANDARD" | "DEEP">;
    suggestedExtraNodes: string[];
    riskWarnings: string[];
  } {
    const records = this.store.records.filter(r => r.templateName === templateName);
    if (records.length === 0) {
      return { suggestedIntensity: {}, suggestedExtraNodes: [], riskWarnings: [] };
    }

    // 基于历史数据推荐专家强度
    const intensity: Record<string, "LIGHT" | "STANDARD" | "DEEP"> = {};
    const relevantInsights = this.store.insights.filter(
      i => i.type === "expert_scheduling" && i.confidence > 0.5
    );
    for (const insight of relevantInsights) {
      const expertMatch = insight.description.match(/"([^"]+)"/);
      if (expertMatch && insight.recommendation.includes("DEEP")) {
        intensity[expertMatch[1]] = "DEEP";
      }
    }

    // 风险警告
    const riskWarnings = this.store.insights
      .filter(i => i.type === "bottleneck_warning" && !i.applied)
      .map(i => i.description);

    return { suggestedIntensity: intensity, suggestedExtraNodes: [], riskWarnings };
  }

  /**
   * 导出学习数据
   */
  export(): LearningStore {
    return JSON.parse(JSON.stringify(this.store));
  }

  /**
   * 获取统计摘要
   */
  getSummary(): {
    totalProjects: number;
    avgCorrectionsPerNode: number;
    topBottleneck: string | null;
    bestTemplate: string | null;
  } {
    const records = this.store.records;
    if (records.length === 0) {
      return { totalProjects: 0, avgCorrectionsPerNode: 0, topBottleneck: null, bestTemplate: null };
    }

    const avgCorrections = records.reduce((s, r) => s + r.dagResult.avgCorrectionsPerNode, 0) / records.length;

    const templateSuccess = this.groupByTemplate(records);
    let bestTemplate: string | null = null;
    let bestScore = Infinity;
    for (const [tpl, recs] of Object.entries(templateSuccess)) {
      const score = recs.reduce((s, r) => s + r.dagResult.avgCorrectionsPerNode, 0) / recs.length;
      if (score < bestScore) { bestScore = score; bestTemplate = tpl; }
    }

    const bottleneckInsights = this.store.insights.filter(i => i.type === "bottleneck_warning" && !i.applied);

    return {
      totalProjects: records.length,
      avgCorrectionsPerNode: Math.round(avgCorrections * 100) / 100,
      topBottleneck: bottleneckInsights[0]?.description ?? null,
      bestTemplate,
    };
  }

  // ============================================================
  // 私有方法
  // ============================================================

  private groupByTemplate(records: ExecutionRecord[]): Record<string, ExecutionRecord[]> {
    const groups: Record<string, ExecutionRecord[]> = {};
    for (const r of records) {
      const key = r.templateName || "unknown";
      (groups[key] ??= []).push(r);
    }
    return groups;
  }

  private groupByExpert(records: ExecutionRecord[]): Record<string, { count: number; avgSuccessRate: number; projects: string[] }> {
    const stats: Record<string, { successRates: number[]; projects: string[] }> = {};
    for (const r of records) {
      for (const es of r.expertStats) {
        const s = (stats[es.expert] ??= { successRates: [], projects: [] });
        s.successRates.push(es.successRate);
        s.projects.push(r.projectName);
      }
    }
    const result: Record<string, { count: number; avgSuccessRate: number; projects: string[] }> = {};
    for (const [expert, s] of Object.entries(stats)) {
      result[expert] = {
        count: s.successRates.length,
        avgSuccessRate: s.successRates.reduce((a, b) => a + b, 0) / s.successRates.length,
        projects: [...new Set(s.projects)],
      };
    }
    return result;
  }

  private findFrequentBlockedNodes(records: ExecutionRecord[]): Array<{
    nodeType: string;
    count: number;
    commonReason: string;
    projects: string[];
  }> {
    // 简化实现：检查 blockedNodes > 0 的记录
    const blockedRecords = records.filter(r => r.dagResult.blockedNodes > 0);
    if (blockedRecords.length === 0) return [];

    return [{
      nodeType: "REVIEW",
      count: blockedRecords.length,
      commonReason: "专家评审发现P0问题且无法自动修正",
      projects: blockedRecords.map(r => r.projectName),
    }];
  }
}

// ============================================================
// 工厂函数
// ============================================================

export function createRetrospectiveEngine(existingData?: LearningStore): RetrospectiveEngine {
  return new RetrospectiveEngine(existingData);
}
