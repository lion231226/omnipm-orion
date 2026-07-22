/**
 * OmniPM v2.2.0 — Abstract Runtime Interface (ARI)
 * 
 * 平台无关的运行时抽象层。所有平台适配器实现此接口，
 * OmniPM 核心逻辑只依赖 ARI，不依赖具体平台。
 * 
 * 设计原则：
 * - 最小接口：只抽象 OmniPM 真正需要的平台能力
 * - 渐进增强：适配器可部分实现（通过能力矩阵声明）
 * - 可测试：每个接口都可 mock
 */

// ============================================================
// 基础类型
// ============================================================

/** 平台标识 */
export type Platform = "pi" | "claude" | "gemini" | "unknown";

/** 消息角色（跨平台通用） */
export type MessageRole = "system" | "user" | "assistant";

/** 消息内容块 */
export interface ContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result";
  text?: string;
  data?: string;          // base64 for images
  toolName?: string;      // for tool_use
  toolId?: string;        // for tool_use / tool_result
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
}

/** 通用消息 */
export interface Message {
  role: MessageRole;
  content: ContentBlock[];
}

/** 工具调用结果 */
export interface ToolResult {
  content: ContentBlock[];
  details?: Record<string, unknown>;
}

// ============================================================
// 能力矩阵
// ============================================================

/** 平台能力声明 */
export interface PlatformCapabilities {
  platform: Platform;
  /** 子代理模式 */
  subagentMode: "native_process" | "api_request" | "inline";
  /** 最大并发子代理数 */
  maxConcurrency: number;
  /** 是否支持进程隔离 */
  processIsolation: boolean;
  /** 事件总线 */
  hasEventBus: boolean;
  /** DAG 持久化方式 */
  dagPersistence: "tool_state" | "json_file" | "none";
  /** 上下文窗口大小（tokens） */
  contextWindow: number;
  /** 工具调用机制 */
  toolCallMechanism: "native" | "function_calling" | "text_instruction";
}

// ============================================================
// 子代理接口
// ============================================================

export interface AgentConfig {
  name: string;
  displayName?: string;
  systemPrompt: string;
  model?: string;
  tools?: string[];
  scope: "omnipm" | "user" | "both";
}

export interface SubagentProcess {
  processId: string;
  agentName: string;
  status: "running" | "completed" | "failed" | "aborted";
  startTime: number;
}

export interface ExpertResult {
  expert: string;
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    turns: number;
  };
  model?: string;
  stopReason?: string;
  severity?: "P0" | "P1" | "P2";
  claimedFiles: string[];
}

export interface ISubagentRuntime {
  /** 获取可用代理列表 */
  listAgents(scope?: "omnipm" | "user" | "both"): Promise<AgentConfig[]>;
  /** 启动子代理 */
  spawn(config: AgentConfig, task: string, options?: SubagentOptions): Promise<ExpertResult>;
  /** 批量并行执行 */
  spawnParallel(configs: Array<{ agent: AgentConfig; task: string }>, options?: SubagentOptions): Promise<ExpertResult[]>;
  /** 链式执行 */
  spawnChain(steps: Array<{ agent: AgentConfig; task: string }>, options?: ChainOptions): Promise<ChainResult>;
  /** 获取平台能力 */
  getCapabilities(): PlatformCapabilities;
  /** 终止子代理 */
  kill(processId: string): Promise<void>;
}

export interface SubagentOptions {
  signal?: AbortSignal;
  intensity?: "LIGHT" | "STANDARD" | "DEEP" | "PAIR";
  dagContextFile?: string;
  timeout?: number; // ms
}

export interface ChainOptions extends SubagentOptions {
  onError?: "stop" | "skip" | "retry";
  maxRetries?: number;
}

export interface ChainStepResult {
  step: { agent: AgentConfig; task: string };
  result: ExpertResult;
  success: boolean;
  failureType?: string;
  retryCount: number;
}

export interface ChainResult {
  steps: ChainStepResult[];
  finalOutput: string;
  successCount: number;
  failureCount: number;
}

// ============================================================
// 文件系统接口
// ============================================================

export interface IFileSystem {
  readonly cwd: string;
  read(path: string, encoding?: BufferEncoding): Promise<string>;
  readBinary(path: string): Promise<Buffer>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  unlink(path: string): Promise<void>;
  glob(pattern: string): Promise<string[]>;
  /** 原子写入：临时文件 → fsync → 重命名 */
  atomicWrite(path: string, content: string): Promise<void>;
}

// ============================================================
// 存储接口
// ============================================================

export interface IStorage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** DAG 状态专用 */
  loadDAGState(projectName: string): Promise<DAGState | null>;
  saveDAGState(projectName: string, state: DAGState): Promise<void>;
}

// ============================================================
// 事件总线接口
// ============================================================

export type EventHandler = (event: RuntimeEvent) => void | Promise<void>;

export interface RuntimeEvent {
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface IEventBus {
  on(eventType: string, handler: EventHandler): void;
  off(eventType: string, handler: EventHandler): void;
  emit(eventType: string, payload: Record<string, unknown>): void;
}

// ============================================================
// 用户界面接口
// ============================================================

export interface IUserInterface {
  notify(message: string, level: "info" | "warning" | "error"): void;
  confirm(message: string): Promise<boolean>;
  /** GATE 门控专用：等待用户输入 */
  waitForGate(gateName: string, context: string): Promise<"confirm" | "reject" | "modify">;
}

// ============================================================
// 统一运行时上下文
// ============================================================

export interface RuntimeContext {
  platform: Platform;
  capabilities: PlatformCapabilities;
  subagent: ISubagentRuntime;
  fs: IFileSystem;
  storage: IStorage;
  events: IEventBus;
  ui: IUserInterface;
}

// ============================================================
// DAG 状态类型（平台无关）
// ============================================================

export type NodeStatus = "pending" | "ready" | "running" | "done" | "failed" | "blocked" | "awaiting_gate";
export type NodeType = "ANALYSIS" | "DESIGN" | "REVIEW" | "DEVELOP" | "TEST" | "DELIVER" | "GATE";

export interface DAGNode {
  nodeId: string;
  name: string;
  status: NodeStatus;
  nodeType?: NodeType;
  domain?: string;
  dependsOn: string[];
  correctionCount: number;
  startedAt?: string;
  completedAt?: string;
  outputs?: {
    files: string[];
    keyDecisions?: string[];
    artifacts?: string[];
  };
}

export interface DAGEdge {
  from: string;
  to: string;
  condition: "always" | "on_success" | "on_failure";
}

export interface DAGState {
  version: string;
  projectName: string;
  dagId: string;
  nodes: DAGNode[];
  edges?: DAGEdge[];
  currentNode?: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// DAG 建议（子代理输出解析）
// ============================================================

export interface DAGSuggestion {
  action: "complete" | "fail" | "retry" | "blocked";
  nodeId: string;
  reason: string;
  severity?: "P0" | "P1" | "P2";
  correctionCount?: number;
}

// ============================================================
// 跨平台提示词适配
// ============================================================

export interface PlatformPromptConfig {
  /** 系统提示词前缀（平台特定指令） */
  prefix: string;
  /** 工具调用格式说明 */
  toolCallFormat: string;
  /** GATE 门控格式模板 */
  gateTemplate: string;
  /** 子代理调度说明 */
  subagentInstructions: string;
  /** 平台约束说明 */
  constraints: string[];
}

/**
 * 平台提示词配置表
 * 
 * 每种平台的 OMNIPM_SYSTEM_PROMPT.md 主体 100% 相同，
 * 仅替换此配置中的差异部分。
 */
export const PLATFORM_PROMPT_CONFIGS: Record<Platform, PlatformPromptConfig> = {
  pi: {
    prefix: "",
    toolCallFormat: "使用 run_experts 和 omni_dag 两个 Extension 工具。",
    gateTemplate: "输出 GATE 块后暂停，等待用户回复。",
    subagentInstructions: "通过 run_experts 工具调度 13 位专家子代理。每位专家在独立 pi 进程中运行。",
    constraints: [],
  },
  claude: {
    prefix: "> 你运行在 Claude 平台。使用 Claude Tool Use 机制调用工具。\n\n",
    toolCallFormat: "使用 `run_experts` 和 `omni_dag` 两个工具（通过 Tool Use）。\n工具调用失败时不要假设成功，检查返回内容。",
    gateTemplate: "输出 GATE 块后使用 `ask_user` 工具暂停，等待用户回复。",
    subagentInstructions: "通过 `run_experts` 工具调度专家。Claude 平台下，子代理以独立请求方式运行。\n受限于平台机制，最大并发为 1，请按顺序调度。",
    constraints: [
      "Claude 无原生进程 fork，子代理并发数上限 = 1",
      "文件操作为同步模式",
      "DAG 状态仅持久化到 JSON 文件",
    ],
  },
  gemini: {
    prefix: "> 你运行在 Gemini 平台。使用 Google Function Calling 调用工具。\n\n",
    toolCallFormat: "使用 `run_experts` 和 `omni_dag` 两个函数（通过 Function Calling）。\n函数调用失败时检查 error 字段并重试。",
    gateTemplate: "输出 GATE 块后暂停，等待用户回复。",
    subagentInstructions: "通过 `run_experts` 工具调度专家。Gemini 平台下使用并行 API 调用。\n得益于 1M+ 上下文窗口，可承载大量上下文。",
    constraints: [
      "Gemini Function Calling 响应格式与 Claude 不同",
      "上下文窗口 1M+ tokens（优势）",
      "DAG 状态仅持久化到 JSON 文件",
    ],
  },
  unknown: {
    prefix: "> 平台未知。使用纯文本指令模式。\n\n",
    toolCallFormat: "以 Markdown 代码块描述工具调用意图。",
    gateTemplate: "输出 GATE 块后标明 [WAIT_USER_INPUT]。",
    subagentInstructions: "以文本模拟专家评审过程。",
    constraints: ["工具调用需人工协助", "无进程隔离"],
  },
};
