/**
 * OmniPM v2.4.0 — 可编程条件分支工具（P2-2）
 * 
 * 为 DAG 增加运行时条件分支能力。
 * condition_branch 工具允许 Orion 基于子代理输出动态决定下一步执行路径。
 */

import type { DAGState, DAGNode, ExpertResult } from "./interface.ts";

// ============================================================
// 条件类型
// ============================================================

export type ConditionOperator =
  | "equals"           // 字符串相等
  | "contains"         // 字符串包含
  | "matches"          // 正则匹配
  | "gt" | "gte" | "lt" | "lte"  // 数值比较
  | "in"               // 值在列表中
  | "exists"           // 值存在（非null/undefined/空字符串）
  | "severity_is"      // 严重等级为指定等级
  | "severity_gte"     // 严重等级 ≥ 指定等级（P0>P1>P2）

export interface BranchCondition {
  /** 数据源: "expert_result" | "dag_state" | "file_content" */
  source: "expert_result" | "dag_state" | "file_content";
  /** 条件字段（JSONPath 简化版，点号分隔） */
  field: string;
  /** 操作符 */
  operator: ConditionOperator;
  /** 比较值 */
  value: string | number | boolean | string[];
  /** 专家名（source=expert_result 时必填） */
  expertName?: string;
}

export interface BranchCase {
  /** 分支名称 */
  name: string;
  /** 条件列表（AND 逻辑） */
  conditions: BranchCondition[];
  /** 满足条件时执行的动作 */
  action: BranchAction;
}

export interface BranchAction {
  /** 动作类型 */
  type: "continue_node" | "skip_node" | "insert_node" | "trigger_correction" | "escalate";
  /** 目标节点 ID（continue_node/skip_node 时必填） */
  targetNodeId?: string;
  /** 插入节点定义（insert_node 时必填） */
  insertNode?: {
    id: string;
    name: string;
    type: DAGNode["nodeType"];
    dependsOn: string[];
  };
  /** 原因说明 */
  reason: string;
}

export interface ConditionBranch {
  /** 分支 ID */
  branchId: string;
  /** 分支描述 */
  description: string;
  /** 触发节点（哪个节点完成后评估） */
  triggerNodeId: string;
  /** 分支条件列表（按序评估，首个匹配的生效） */
  cases: BranchCase[];
  /** 默认动作（所有条件都不匹配时） */
  defaultAction: BranchAction;
}

// ============================================================
// 条件评估引擎
// ============================================================

export class ConditionEvaluator {
  private expertResults: Map<string, ExpertResult> = new Map();
  private dagState: DAGState | null = null;

  setExpertResult(name: string, result: ExpertResult): void {
    this.expertResults.set(name, result);
  }

  setDAGState(state: DAGState): void {
    this.dagState = state;
  }

  /**
   * 评估单个条件
   */
  evaluateCondition(condition: BranchCondition): boolean {
    const value = this.resolveField(condition.source, condition.field, condition.expertName);
    return this.compare(value, condition.operator, condition.value);
  }

  /**
   * 评估条件列表（AND 逻辑）
   */
  evaluateConditions(conditions: BranchCondition[]): boolean {
    return conditions.every(c => this.evaluateCondition(c));
  }

  /**
   * 评估完整分支，返回匹配的 action
   */
  evaluateBranch(branch: ConditionBranch): BranchAction {
    for (const c of branch.cases) {
      if (this.evaluateConditions(c.conditions)) {
        return c.action;
      }
    }
    return branch.defaultAction;
  }

  // ============================================================
  // 私有方法
  // ============================================================

  private resolveField(source: string, field: string, expertName?: string): unknown {
    switch (source) {
      case "expert_result": {
        if (!expertName) return undefined;
        const result = this.expertResults.get(expertName);
        if (!result) return undefined;
        return this.getNestedValue(result, field);
      }
      case "dag_state": {
        if (!this.dagState) return undefined;
        return this.getNestedValue(this.dagState, field);
      }
      default:
        return undefined;
    }
  }

  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split(".");
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof current === "object") {
        current = (current as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }
    return current;
  }

  private compare(value: unknown, operator: ConditionOperator, expected: unknown): boolean {
    switch (operator) {
      case "equals":
        return String(value) === String(expected);
      case "contains":
        return String(value).includes(String(expected));
      case "matches":
        try {
          return new RegExp(String(expected)).test(String(value));
        } catch {
          return false;
        }
      case "gt":
        return Number(value) > Number(expected);
      case "gte":
        return Number(value) >= Number(expected);
      case "lt":
        return Number(value) < Number(expected);
      case "lte":
        return Number(value) <= Number(expected);
      case "in":
        return Array.isArray(expected) && expected.map(String).includes(String(value));
      case "exists":
        return value !== null && value !== undefined && value !== "";
      case "severity_is": {
        const sevOrder = { P0: 3, P1: 2, P2: 1 };
        return value === expected;
      }
      case "severity_gte": {
        const sevOrder: Record<string, number> = { P0: 3, P1: 2, P2: 1 };
        return (sevOrder[String(value)] ?? 0) >= (sevOrder[String(expected)] ?? 0);
      }
      default:
        return false;
    }
  }
}

// ============================================================
// 分支执行器
// ============================================================

export interface BranchExecutionResult {
  branchId: string;
  matchedCase: string | null;
  action: BranchAction;
  isDefault: boolean;
}

export class BranchExecutor {
  private evaluator: ConditionEvaluator;

  constructor(evaluator: ConditionEvaluator) {
    this.evaluator = evaluator;
  }

  /**
   * 执行条件分支
   * 
   * @param branch 分支定义
   * @returns 执行结果（含匹配的 case 和要执行的动作）
   */
  execute(branch: ConditionBranch): BranchExecutionResult {
    for (const c of branch.cases) {
      if (this.evaluator.evaluateConditions(c.conditions)) {
        return {
          branchId: branch.branchId,
          matchedCase: c.name,
          action: c.action,
          isDefault: false,
        };
      }
    }

    return {
      branchId: branch.branchId,
      matchedCase: null,
      action: branch.defaultAction,
      isDefault: true,
    };
  }
}

// ============================================================
// 预定义分支模板（常见场景）
// ============================================================

export const BRANCH_TEMPLATES = {
  /** 安全评审结果分支 */
  securityReview: (triggerNodeId: string, reviewNodeId: string): ConditionBranch => ({
    branchId: `SEC-BRANCH-${triggerNodeId}`,
    description: "安全评审结果决定下一步路径",
    triggerNodeId,
    cases: [
      {
        name: "发现P0漏洞",
        conditions: [
          { source: "expert_result", field: "severity", operator: "severity_is", value: "P0", expertName: "security" },
        ],
        action: {
          type: "trigger_correction",
          targetNodeId: triggerNodeId,
          reason: "安全评审发现P0阻塞项，必须修正后重新评审",
        },
      },
      {
        name: "发现P1问题",
        conditions: [
          { source: "expert_result", field: "severity", operator: "severity_is", value: "P1", expertName: "security" },
        ],
        action: {
          type: "continue_node",
          targetNodeId: reviewNodeId,
          reason: "P1问题记录后继续推进，后续节点注意修复",
        },
      },
    ],
    defaultAction: {
      type: "continue_node",
      targetNodeId: reviewNodeId,
      reason: "安全评审通过，正常推进",
    },
  }),

  /** 测试覆盖率门禁分支 */
  coverageGate: (triggerNodeId: string): ConditionBranch => ({
    branchId: `COV-BRANCH-${triggerNodeId}`,
    description: "测试覆盖率决定是否继续推进",
    triggerNodeId,
    cases: [
      {
        name: "覆盖率不足",
        conditions: [
          { source: "expert_result", field: "severity", operator: "severity_gte", value: "P1", expertName: "qa" },
        ],
        action: {
          type: "trigger_correction",
          targetNodeId: triggerNodeId,
          reason: "测试覆盖率未达标，需补充测试",
        },
      },
    ],
    defaultAction: {
      type: "continue_node",
      targetNodeId: "GATE-ACCEPT",
      reason: "测试覆盖率达标，进入验收阶段",
    },
  }),
};
