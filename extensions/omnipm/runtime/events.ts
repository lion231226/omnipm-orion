/**
 * OmniPM v2.4.0 — 事件通信总线（P1-6）
 * 
 * 连接 omni_dag 和 run_experts 工具的事件通信层。
 * 基于 Pi Extension 的 pi.events 事件总线实现。
 * 
 * 核心价值:
 * - omni_dag 状态变更自动通知 run_experts（无需 Orion 手动协调）
 * - run_experts 执行结果自动触发 DAG 状态更新
 * - 熔断/降级事件广播到所有活跃子代理
 */

import type { IEventBus, RuntimeEvent, DAGState, DAGNode, ExpertResult } from "./interface.ts";

// ============================================================
// 事件类型常量
// ============================================================

export const OmniPMEvents = {
  // DAG 生命周期
  DAG_INIT: "omnipm:dag:init",
  DAG_NODE_STARTED: "omnipm:dag:node:started",
  DAG_NODE_COMPLETED: "omnipm:dag:node:completed",
  DAG_NODE_FAILED: "omnipm:dag:node:failed",
  DAG_NODE_BLOCKED: "omnipm:dag:node:blocked",
  DAG_CORRECTION_TRIGGERED: "omnipm:dag:correction:triggered",
  DAG_CONTEXT_UPDATED: "omnipm:dag:context:updated",
  DAG_COMPLETED: "omnipm:dag:completed",

  // 专家执行
  EXPERT_SPAWN_STARTED: "omnipm:expert:spawn:started",
  EXPERT_SPAWN_COMPLETED: "omnipm:expert:spawn:completed",
  EXPERT_SPAWN_FAILED: "omnipm:expert:spawn:failed",
  EXPERT_SPAWN_TRUNCATED: "omnipm:expert:spawn:truncated",

  // 链式调用
  CHAIN_STEP_COMPLETED: "omnipm:chain:step:completed",
  CHAIN_STEP_FAILED: "omnipm:chain:step:failed",
  CHAIN_COMPLETED: "omnipm:chain:completed",

  // 熔断与降级
  CIRCUIT_BREAKER_TRIPPED: "omnipm:circuit:breaker:tripped",
  DEGRADATION_ACTIVATED: "omnipm:degradation:activated",
  DEGRADATION_RESET: "omnipm:degradation:reset",

  // 元事件
  META_GATE_CONFIRMED: "omnipm:meta:gate:confirmed",
  GATE_DESIGN_CONFIRMED: "omnipm:gate:design:confirmed",
  GATE_ACCEPTANCE_CONFIRMED: "omnipm:gate:acceptance:confirmed",
} as const;

export type OmniPMEventType = typeof OmniPMEvents[keyof typeof OmniPMEvents];

// ============================================================
// 事件负载类型
// ============================================================

export interface DAGNodeEventPayload {
  projectName: string;
  nodeId: string;
  nodeName: string;
  nodeType?: string;
  timestamp: string;
}

export interface DAGCorrectionPayload extends DAGNodeEventPayload {
  correctionCount: number;
  reason: string;
  severity: "P0" | "P1" | "P2";
}

export interface ExpertSpawnPayload {
  expert: string;
  task: string;
  intensity?: string;
  nodeId?: string;
  timestamp: string;
}

export interface ExpertResultPayload extends ExpertSpawnPayload {
  exitCode: number;
  severity?: "P0" | "P1" | "P2";
  stopReason?: string;
  tokensUsed: number;
  durationMs: number;
  isTruncated: boolean;
}

export interface CircuitBreakerPayload {
  nodeId: string;
  nodeName: string;
  correctionCount: number;
  reason: string;
  timestamp: string;
}

// ============================================================
// 事件发射器
// ============================================================

export class OmniPMEventEmitter {
  private bus: IEventBus;
  private enabled: boolean;

  constructor(bus: IEventBus, enabled: boolean = true) {
    this.bus = bus;
    this.enabled = enabled;
  }

  /** 发射 DAG 节点启动事件 */
  emitNodeStarted(dag: DAGState, node: DAGNode): void {
    if (!this.enabled) return;
    this.bus.emit(OmniPMEvents.DAG_NODE_STARTED, {
      projectName: dag.projectName,
      nodeId: node.nodeId,
      nodeName: node.name,
      nodeType: node.nodeType,
      timestamp: new Date().toISOString(),
    });
  }

  /** 发射 DAG 节点完成事件 */
  emitNodeCompleted(dag: DAGState, node: DAGNode): void {
    if (!this.enabled) return;
    this.bus.emit(OmniPMEvents.DAG_NODE_COMPLETED, {
      projectName: dag.projectName,
      nodeId: node.nodeId,
      nodeName: node.name,
      nodeType: node.nodeType,
      timestamp: new Date().toISOString(),
    });
  }

  /** 发射 DAG 节点失败事件 */
  emitNodeFailed(dag: DAGState, node: DAGNode, reason: string): void {
    if (!this.enabled) return;
    this.bus.emit(OmniPMEvents.DAG_NODE_FAILED, {
      projectName: dag.projectName,
      nodeId: node.nodeId,
      nodeName: node.name,
      nodeType: node.nodeType,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  /** 发射闭环修正事件 */
  emitCorrection(payload: DAGCorrectionPayload): void {
    if (!this.enabled) return;
    this.bus.emit(OmniPMEvents.DAG_CORRECTION_TRIGGERED, payload);
  }

  /** 发射专家启动事件 */
  emitExpertStarted(payload: ExpertSpawnPayload): void {
    if (!this.enabled) return;
    this.bus.emit(OmniPMEvents.EXPERT_SPAWN_STARTED, payload);
  }

  /** 发射专家完成事件 */
  emitExpertCompleted(payload: ExpertResultPayload): void {
    if (!this.enabled) return;
    this.bus.emit(OmniPMEvents.EXPERT_SPAWN_COMPLETED, payload);
  }

  /** 发射专家失败事件 */
  emitExpertFailed(payload: ExpertResultPayload & { error: string }): void {
    if (!this.enabled) return;
    this.bus.emit(OmniPMEvents.EXPERT_SPAWN_FAILED, payload);
  }

  /** 发射熔断事件 */
  emitCircuitBreaker(payload: CircuitBreakerPayload): void {
    if (!this.enabled) return;
    this.bus.emit(OmniPMEvents.CIRCUIT_BREAKER_TRIPPED, payload);
  }

  /** 发射 DAG 上下文更新事件 */
  emitContextUpdated(projectName: string): void {
    if (!this.enabled) return;
    this.bus.emit(OmniPMEvents.DAG_CONTEXT_UPDATED, {
      projectName,
      timestamp: new Date().toISOString(),
    });
  }

  /** 发射链式步骤完成事件 */
  emitChainStepCompleted(stepIndex: number, expert: string, success: boolean): void {
    if (!this.enabled) return;
    const eventType = success
      ? OmniPMEvents.CHAIN_STEP_COMPLETED
      : OmniPMEvents.CHAIN_STEP_FAILED;
    this.bus.emit(eventType, {
      stepIndex,
      expert,
      timestamp: new Date().toISOString(),
    });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}

// ============================================================
// 事件订阅器（供 run_experts 使用）
// ============================================================

export interface DAGEventListener {
  onNodeStarted: (payload: DAGNodeEventPayload) => void;
  onNodeCompleted: (payload: DAGNodeEventPayload) => void;
  onNodeFailed: (payload: DAGNodeEventPayload & { reason: string }) => void;
  onNodeBlocked: (payload: CircuitBreakerPayload) => void;
}

export function subscribeToDAGEvents(
  bus: IEventBus,
  listener: Partial<DAGEventListener>,
): () => void {
  const handlers: Array<{ type: string; handler: (e: RuntimeEvent) => void }> = [];

  if (listener.onNodeStarted) {
    const h = (e: RuntimeEvent) => listener.onNodeStarted!(e.payload as any);
    bus.on(OmniPMEvents.DAG_NODE_STARTED, h);
    handlers.push({ type: OmniPMEvents.DAG_NODE_STARTED, handler: h });
  }
  if (listener.onNodeCompleted) {
    const h = (e: RuntimeEvent) => listener.onNodeCompleted!(e.payload as any);
    bus.on(OmniPMEvents.DAG_NODE_COMPLETED, h);
    handlers.push({ type: OmniPMEvents.DAG_NODE_COMPLETED, handler: h });
  }
  if (listener.onNodeFailed) {
    const h = (e: RuntimeEvent) => listener.onNodeFailed!(e.payload as any);
    bus.on(OmniPMEvents.DAG_NODE_FAILED, h);
    handlers.push({ type: OmniPMEvents.DAG_NODE_FAILED, handler: h });
  }
  if (listener.onNodeBlocked) {
    const h = (e: RuntimeEvent) => listener.onNodeBlocked!(e.payload as any);
    bus.on(OmniPMEvents.DAG_NODE_BLOCKED, h);
    handlers.push({ type: OmniPMEvents.DAG_NODE_BLOCKED, handler: h });
  }

  // 返回取消订阅函数
  return () => {
    for (const { type, handler } of handlers) {
      bus.off(type, handler);
    }
  };
}

// ============================================================
// 事件日志（调试/审计用）
// ============================================================

export class EventLogger {
  private events: RuntimeEvent[] = [];
  private maxSize: number;

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize;
  }

  record(event: RuntimeEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events = this.events.slice(-this.maxSize);
    }
  }

  getRecent(count?: number): RuntimeEvent[] {
    return count ? this.events.slice(-count) : [...this.events];
  }

  getByType(eventType: string): RuntimeEvent[] {
    return this.events.filter(e => e.type === eventType);
  }

  clear(): void {
    this.events = [];
  }
}
