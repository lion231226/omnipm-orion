/**
 * OmniPM v2.2.0 — Mock Runtime
 * 
 * 用于单元测试的完整 Mock 实现。
 * 所有接口均可通过构造函数注入预设行为。
 */

import type {
  AgentConfig, ChainOptions, ChainResult, DAGState,
  EventHandler, ExpertResult, IEventBus, IFileSystem,
  ISubagentRuntime, IStorage, IUserInterface,
  Platform, PlatformCapabilities, RuntimeContext, RuntimeEvent,
  SubagentOptions,
} from "./interface.ts";

// ============================================================
// Mock FileSystem
// ============================================================

export class MockFileSystem implements IFileSystem {
  cwd = "/mock/project";
  private files: Map<string, string> = new Map();
  private _existsResults: Map<string, boolean> = new Map();

  /** 预设文件内容 */
  setFile(path: string, content: string): void {
    this.files.set(path, content);
    this._existsResults.set(path, true);
  }

  /** 预设 exists 返回值 */
  setExists(path: string, exists: boolean): void {
    this._existsResults.set(path, exists);
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }

  async readBinary(_path: string): Promise<Buffer> {
    return Buffer.from("");
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    this._existsResults.set(path, true);
  }

  async exists(path: string): Promise<boolean> {
    return this._existsResults.get(path) ?? this.files.has(path);
  }

  async mkdir(_path: string, _options?: { recursive?: boolean }): Promise<void> {}

  async unlink(path: string): Promise<void> {
    this.files.delete(path);
    this._existsResults.delete(path);
  }

  async glob(_pattern: string): Promise<string[]> {
    const result: string[] = [];
    for (const key of this.files.keys()) result.push(key);
    return result;
  }

  async atomicWrite(path: string, content: string): Promise<void> {
    await this.write(path, content);
  }
}

// ============================================================
// Mock Subagent Runtime
// ============================================================

export class MockSubagentRuntime implements ISubagentRuntime {
  agents: AgentConfig[] = [];
  private _resultOverride: ExpertResult | null = null;
  private _results: ExpertResult[] = [];
  private _resultIndex = 0;
  private _capabilities: PlatformCapabilities;

  constructor(capabilities?: Partial<PlatformCapabilities>) {
    this._capabilities = {
      platform: "pi",
      subagentMode: "native_process",
      maxConcurrency: 4,
      processIsolation: true,
      hasEventBus: true,
      dagPersistence: "tool_state",
      contextWindow: 200000,
      toolCallMechanism: "native",
      ...capabilities,
    };
  }

  /** 预设单个结果（每次 spawn 返回相同结果） */
  setResultOverride(result: ExpertResult): void {
    this._resultOverride = result;
  }

  /** 预设多个结果（按顺序返回） */
  setResults(results: ExpertResult[]): void {
    this._results = results;
    this._resultIndex = 0;
  }

  /** 构建标准成功结果 */
  static successResult(expert: string, output: string, severity?: "P0" | "P1" | "P2"): ExpertResult {
    return {
      expert,
      task: "mock task",
      exitCode: 0,
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: output }],
      }],
      stderr: "",
      usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 5000, turns: 1 },
      severity,
      claimedFiles: [],
    };
  }

  /** 构建标准失败结果 */
  static failureResult(expert: string, error: string): ExpertResult {
    return {
      expert,
      task: "mock task",
      exitCode: 1,
      messages: [],
      stderr: error,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      claimedFiles: [],
    };
  }

  async listAgents(_scope?: string): Promise<AgentConfig[]> {
    return this.agents;
  }

  async spawn(_config: AgentConfig, _task: string, _options?: SubagentOptions): Promise<ExpertResult> {
    if (this._resultOverride) return { ...this._resultOverride };
    if (this._results.length > 0) {
      const r = this._results[this._resultIndex];
      this._resultIndex = (this._resultIndex + 1) % this._results.length;
      return { ...r };
    }
    return MockSubagentRuntime.successResult("mock", "mock output");
  }

  async spawnParallel(configs: Array<{ agent: AgentConfig; task: string }>, _options?: SubagentOptions): Promise<ExpertResult[]> {
    return Promise.all(configs.map(c => this.spawn(c.agent, c.task, _options)));
  }

  async spawnChain(steps: Array<{ agent: AgentConfig; task: string }>, _options?: ChainOptions): Promise<ChainResult> {
    const stepResults = [];
    for (const step of steps) {
      const result = await this.spawn(step.agent, step.task);
      stepResults.push({ step, result, success: result.exitCode === 0, retryCount: 0 });
    }
    return {
      steps: stepResults,
      finalOutput: "chain completed",
      successCount: stepResults.filter(s => s.success).length,
      failureCount: stepResults.filter(s => !s.success).length,
    };
  }

  getCapabilities(): PlatformCapabilities {
    return { ...this._capabilities };
  }

  async kill(_processId: string): Promise<void> {}
}

// ============================================================
// Mock Storage
// ============================================================

export class MockStorage implements IStorage {
  private store: Map<string, unknown> = new Map();

  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async loadDAGState(_projectName: string): Promise<DAGState | null> {
    return this.store.get("dag_state") as DAGState ?? null;
  }

  async saveDAGState(_projectName: string, state: DAGState): Promise<void> {
    this.store.set("dag_state", state);
  }
}

// ============================================================
// Mock Event Bus
// ============================================================

export class MockEventBus implements IEventBus {
  handlers: Map<string, EventHandler[]> = new Map();
  emitted: RuntimeEvent[] = [];

  on(eventType: string, handler: EventHandler): void {
    const list = this.handlers.get(eventType) ?? [];
    list.push(handler);
    this.handlers.set(eventType, list);
  }

  off(eventType: string, handler: EventHandler): void {
    const list = this.handlers.get(eventType) ?? [];
    this.handlers.set(eventType, list.filter(h => h !== handler));
  }

  emit(eventType: string, payload: Record<string, unknown>): void {
    const event: RuntimeEvent = { type: eventType, payload, timestamp: new Date().toISOString() };
    this.emitted.push(event);
    for (const h of this.handlers.get(eventType) ?? []) h(event);
  }

  /** 断言特定事件已发射 */
  assertEmitted(eventType: string, match?: Partial<Record<string, unknown>>): boolean {
    return this.emitted.some(e =>
      e.type === eventType &&
      (!match || Object.entries(match).every(([k, v]) => e.payload[k] === v))
    );
  }
}

// ============================================================
// Mock UI
// ============================================================

export class MockUserInterface implements IUserInterface {
  notifications: Array<{ message: string; level: string }> = [];
  confirmResponses: boolean[] = [];
  gateResponses: Array<"confirm" | "reject" | "modify"> = [];
  private _confirmIndex = 0;
  private _gateIndex = 0;

  notify(message: string, level: "info" | "warning" | "error"): void {
    this.notifications.push({ message, level });
  }

  setConfirmResponses(values: boolean[]): void {
    this.confirmResponses = values;
    this._confirmIndex = 0;
  }

  setGateResponses(values: Array<"confirm" | "reject" | "modify">): void {
    this.gateResponses = values;
    this._gateIndex = 0;
  }

  async confirm(_message: string): Promise<boolean> {
    return this.confirmResponses[this._confirmIndex++] ?? true;
  }

  async waitForGate(_gateName: string, _context: string): Promise<"confirm" | "reject" | "modify"> {
    return this.gateResponses[this._gateIndex++] ?? "confirm";
  }
}

// ============================================================
// 完整 Mock 运行时工厂
// ============================================================

export function createMockRuntime(platform: Platform = "pi", overrides?: {
  fs?: Partial<MockFileSystem>;
  subagent?: Partial<MockSubagentRuntime>;
  storage?: Partial<MockStorage>;
  events?: Partial<MockEventBus>;
  ui?: Partial<MockUserInterface>;
}): {
  ctx: RuntimeContext;
  fs: MockFileSystem;
  subagent: MockSubagentRuntime;
  storage: MockStorage;
  events: MockEventBus;
  ui: MockUserInterface;
} {
  const fs = new MockFileSystem();
  const subagent = new MockSubagentRuntime({ platform });
  const storage = new MockStorage();
  const events = new MockEventBus();
  const ui = new MockUserInterface();

  // 应用覆盖
  Object.assign(fs, overrides?.fs);
  Object.assign(subagent, overrides?.subagent);
  Object.assign(storage, overrides?.storage);
  Object.assign(events, overrides?.events);
  Object.assign(ui, overrides?.ui);

  const ctx: RuntimeContext = {
    platform,
    capabilities: subagent.getCapabilities(),
    subagent,
    fs,
    storage,
    events,
    ui,
  };

  return { ctx, fs, subagent, storage, events, ui };
}
