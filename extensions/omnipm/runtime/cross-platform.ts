/**
 * OmniPM v2.5.0 — 跨平台适配器（DEV-9 修复：真实 SDK 集成）
 * 
 * 实现 Claude Code 和 Codex 平台的 ISubagentRuntime 适配器。
 * 当 OmniPM 安装到 Claude Code / Codex 平台时，这些适配器提供原生的子代理能力。
 * 
 * - ClaudeAdapter: 通过 @anthropic-ai/sdk 发起子代理调用
 * - CodexAdapter:  通过 openai SDK 发起子代理调用
 * 
 * P2-3: 跨平台兼容层
 */

import type {
  AgentConfig,
  ChainOptions,
  ChainResult,
  ExpertResult,
  ISubagentRuntime,
  PlatformCapabilities,
  SubagentOptions,
} from "./interface.ts";

// ============================================================
// 工具函数
// ============================================================

/** 构建 API key 缺失时的错误结果 */
function missingKeyResult(config: AgentConfig, task: string, envVar: string): ExpertResult {
  return {
    expert: config.name,
    task,
    exitCode: 1,
    messages: [{
      role: "assistant",
      content: [{
        type: "text",
        text: `[${config.name}] 无法执行：环境变量 ${envVar} 未设置。请在当前平台配置 API key 后重试。`,
      }],
    }],
    stderr: `${envVar} not set — adapter requires platform API key`,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    claimedFiles: [],
  };
}

/** 构建异常结果 */
function errorResult(config: AgentConfig, task: string, err: unknown): ExpertResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    expert: config.name,
    task,
    exitCode: 1,
    messages: [{
      role: "assistant",
      content: [{ type: "text", text: `[${config.name}] 子代理执行失败: ${message}` }],
    }],
    stderr: message,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    claimedFiles: [],
  };
}

/** 合并默认选项 */
function resolveTimeout(options?: SubagentOptions): number {
  return options?.timeout || 120_000; // 默认 120s
}

// ============================================================
// Claude Code 平台适配器
// ============================================================

export const CLAUDE_CAPABILITIES: PlatformCapabilities = {
  platform: "claude",
  subagentMode: "api_request",
  maxConcurrency: 1,
  processIsolation: false,
  hasEventBus: false,
  dagPersistence: "json_file",
  contextWindow: 200000,
  toolCallMechanism: "native",
};

export class ClaudeAdapter implements ISubagentRuntime {
  private agents: AgentConfig[] = [];
  private defaultModel = "claude-sonnet-4-20250514";

  constructor(agents?: AgentConfig[]) {
    if (agents) this.agents = agents;
  }

  async listAgents(_scope?: string): Promise<AgentConfig[]> {
    return this.agents;
  }

  async spawn(config: AgentConfig, task: string, options?: SubagentOptions): Promise<ExpertResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return missingKeyResult(config, task, "ANTHROPIC_API_KEY");

    // 动态导入 SDK（避免在非 Claude 平台触发模块解析错误）
    const { Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });
    const model = config.model || this.defaultModel;

    try {
      const response = await client.messages.create(
        {
          model,
          max_tokens: 4096,
          system: config.systemPrompt,
          messages: [{ role: "user", content: task }],
        },
        {
          signal: options?.signal,
          timeout: resolveTimeout(options),
        },
      );

      // 提取文本内容（跳过 tool_use 等非文本块）
      const textBlocks = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map(c => c.text);

      const textContent = textBlocks.join("\n") || "(no text output)";

      // 提取文件声明（搜索工具产生的文件路径）
      const claimedFiles = extractClaimedFiles(textContent);

      return {
        expert: config.name,
        task,
        exitCode: 0,
        messages: [{
          role: "assistant",
          content: [{ type: "text", text: textContent }],
        }],
        stderr: "",
        usage: {
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0,
          cacheRead: response.usage?.cache_read_input_tokens || 0,
          cacheWrite: response.usage?.cache_creation_input_tokens || 0,
          cost: calculateClaudeCost(model, response.usage),
          contextTokens: response.usage?.input_tokens || 0,
          turns: 1,
        },
        model: response.model,
        stopReason: response.stop_reason || undefined,
        claimedFiles,
      };
    } catch (err: any) {
      return errorResult(config, task, err);
    }
  }

  async spawnParallel(
    configs: Array<{ agent: AgentConfig; task: string }>,
    options?: SubagentOptions,
  ): Promise<ExpertResult[]> {
    // Claude 平台并发上限=1，按顺序执行
    const results: ExpertResult[] = [];
    for (const c of configs) {
      results.push(await this.spawn(c.agent, c.task, options));
    }
    return results;
  }

  async spawnChain(
    steps: Array<{ agent: AgentConfig; task: string }>,
    options?: ChainOptions,
  ): Promise<ChainResult> {
    let previousOutput = "";
    const stepResults = [];
    let successCount = 0;
    let failureCount = 0;

    for (const step of steps) {
      // 支持 {previous} 占位符替换
      let resolvedTask = step.task;
      if (previousOutput) {
        resolvedTask = resolvedTask
          .replace(/\{previous\}/g, previousOutput)
          .replace(/\{previous:brief\}/g, previousOutput.slice(0, 2000))
          .replace(/\{previous:summary\}/g, previousOutput.slice(0, 500));
      }

      const result = await this.spawn(step.agent, resolvedTask, options);
      const success = result.exitCode === 0;
      if (success) {
        successCount++;
        previousOutput = result.messages[0]?.content[0]?.text || "";
      } else {
        failureCount++;
        if (options?.onError === "stop") break;
      }

      stepResults.push({
        step: { agent: step.agent, task: resolvedTask },
        result,
        success,
        retryCount: 0,
      });
    }

    return {
      steps: stepResults,
      finalOutput: previousOutput || `Claude chain: ${successCount}/${stepResults.length} steps succeeded`,
      successCount,
      failureCount,
    };
  }

  getCapabilities(): PlatformCapabilities {
    return { ...CLAUDE_CAPABILITIES };
  }

  async kill(_processId: string): Promise<void> {}
}

// ============================================================
// Codex 平台适配器
// ============================================================

export const CODEX_CAPABILITIES: PlatformCapabilities = {
  platform: "codex",
  subagentMode: "api_request",
  maxConcurrency: 4,
  processIsolation: false,
  hasEventBus: false,
  dagPersistence: "json_file",
  contextWindow: 128000,
  toolCallMechanism: "function_calling",
};

export class CodexAdapter implements ISubagentRuntime {
  private agents: AgentConfig[] = [];
  private defaultModel = "gpt-4o";

  constructor(agents?: AgentConfig[]) {
    if (agents) this.agents = agents;
  }

  async listAgents(_scope?: string): Promise<AgentConfig[]> {
    return this.agents;
  }

  async spawn(config: AgentConfig, task: string, options?: SubagentOptions): Promise<ExpertResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return missingKeyResult(config, task, "OPENAI_API_KEY");

    // 动态导入 SDK
    const { OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey });
    const model = config.model || this.defaultModel;

    // 构建消息列表
    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (config.systemPrompt) {
      messages.push({ role: "system", content: config.systemPrompt });
    }
    messages.push({ role: "user", content: task });

    try {
      const response = await client.chat.completions.create(
        {
          model,
          messages,
          max_tokens: 4096,
        },
        {
          signal: options?.signal,
          timeout: resolveTimeout(options),
        },
      );

      const choice = response.choices?.[0];
      const textContent = choice?.message?.content || "(no text output)";
      const claimedFiles = extractClaimedFiles(textContent);

      return {
        expert: config.name,
        task,
        exitCode: 0,
        messages: [{
          role: "assistant",
          content: [{ type: "text", text: textContent }],
        }],
        stderr: "",
        usage: {
          input: response.usage?.prompt_tokens || 0,
          output: response.usage?.completion_tokens || 0,
          cacheRead: response.usage?.prompt_tokens_details?.cached_tokens || 0,
          cacheWrite: 0,
          cost: calculateCodexCost(model, response.usage),
          contextTokens: response.usage?.prompt_tokens || 0,
          turns: 1,
        },
        model: response.model,
        stopReason: choice?.finish_reason || undefined,
        claimedFiles,
      };
    } catch (err: any) {
      return errorResult(config, task, err);
    }
  }

  async spawnParallel(
    configs: Array<{ agent: AgentConfig; task: string }>,
    options?: SubagentOptions,
  ): Promise<ExpertResult[]> {
    // Codex 平台：支持并行 API 调用
    return Promise.all(configs.map(c => this.spawn(c.agent, c.task, options)));
  }

  async spawnChain(
    steps: Array<{ agent: AgentConfig; task: string }>,
    options?: ChainOptions,
  ): Promise<ChainResult> {
    let previousOutput = "";
    const stepResults = [];
    let successCount = 0;
    let failureCount = 0;

    for (const step of steps) {
      let resolvedTask = step.task;
      if (previousOutput) {
        resolvedTask = resolvedTask
          .replace(/\{previous\}/g, previousOutput)
          .replace(/\{previous:brief\}/g, previousOutput.slice(0, 2000))
          .replace(/\{previous:summary\}/g, previousOutput.slice(0, 500));
      }

      const result = await this.spawn(step.agent, resolvedTask, options);
      const success = result.exitCode === 0;
      if (success) {
        successCount++;
        previousOutput = result.messages[0]?.content[0]?.text || "";
      } else {
        failureCount++;
        if (options?.onError === "stop") break;
      }

      stepResults.push({
        step: { agent: step.agent, task: resolvedTask },
        result,
        success,
        retryCount: 0,
      });
    }

    return {
      steps: stepResults,
      finalOutput: previousOutput || `Codex chain: ${successCount}/${stepResults.length} steps succeeded`,
      successCount,
      failureCount,
    };
  }

  getCapabilities(): PlatformCapabilities {
    return { ...CODEX_CAPABILITIES };
  }

  async kill(_processId: string): Promise<void> {}
}

// ============================================================
// 向后兼容：GeminiAdapter 别名（v2.5.0 前旧名称）
// ============================================================

/** @deprecated 使用 CodexAdapter 替代 */
export const GeminiAdapter = CodexAdapter;

// ============================================================
// 平台适配器工厂
// ============================================================

export function createAdapter(
  platform: string,
  agents?: AgentConfig[],
): ISubagentRuntime {
  switch (platform) {
    case "claude":
      return new ClaudeAdapter(agents);
    case "codex":
    case "gemini":  // 向后兼容
      return new CodexAdapter(agents);
    case "pi":
    default:
      throw new Error("Pi platform should use PiAdapter (pi-adapter.ts), not generic adapter");
  }
}

// ============================================================
// 平台能力矩阵（跨平台对比）
// ============================================================

export const CROSS_PLATFORM_MATRIX: Record<string, PlatformCapabilities> = {
  pi: CLAUDE_CAPABILITIES, // 实际使用 PI_CAPABILITIES（来自 pi-adapter.ts）
  claude: CLAUDE_CAPABILITIES,
  codex: CODEX_CAPABILITIES,
  gemini: CODEX_CAPABILITIES, // 向后兼容
};

/**
 * 获取平台降级策略
 * 当某平台不支持某个能力时，返回替代方案
 */
export function getDegradationStrategy(
  platform: string,
  capability: keyof PlatformCapabilities,
): string | null {
  const strategies: Record<string, Record<string, string>> = {
    claude: {
      processIsolation: "降级：无进程隔离，子代理以独立 API 请求运行",
      maxConcurrency: "降级：并发上限=1，按顺序执行子代理",
      hasEventBus: "降级：使用文件轮询替代事件总线",
    },
    codex: {
      processIsolation: "降级：无进程隔离，子代理以独立 API 请求运行",
      hasEventBus: "降级：使用文件轮询替代事件总线",
    },
    gemini: {
      processIsolation: "降级：无进程隔离，子代理以独立 API 请求运行",
      hasEventBus: "降级：使用文件轮询替代事件总线",
    },
  };
  return strategies[platform]?.[capability] ?? null;
}

// ============================================================
// 内部工具函数
// ============================================================

/** 从文本内容提取文件路径声明 */
function extractClaimedFiles(text: string): string[] {
  const files: string[] = [];
  // 匹配常见文件声明模式：
  // - `**文件**: path/to/file`
  // - `产出文件: path/to/file`
  // - 代码块 ``path/to/file``
  const patterns = [
    /\*{0,2}(?:产出)?文件\*{0,2}[：:]\s*`?([^\s`\n]+)`?/g,
    /`([a-zA-Z0-9_\-/.]+\.(ts|js|md|json|yaml|yml|go|py|java|rs))`/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const f = match[1];
      if (!files.includes(f)) files.push(f);
    }
  }
  return files;
}

/** Claude 模型成本估算（USD / 1M tokens） */
function calculateClaudeCost(model: string, usage?: { input_tokens?: number; output_tokens?: number }): number {
  if (!usage) return 0;
  // Claude Sonnet 4 定价: $3/$15 per 1M input/output tokens
  let inputRate = 3, outputRate = 15;
  if (model.includes("opus")) { inputRate = 15; outputRate = 75; }
  if (model.includes("haiku")) { inputRate = 0.8; outputRate = 4; }
  return ((usage.input_tokens || 0) / 1_000_000) * inputRate +
         ((usage.output_tokens || 0) / 1_000_000) * outputRate;
}

/** Codex/OpenAI 模型成本估算 */
function calculateCodexCost(model: string, usage?: { prompt_tokens?: number; completion_tokens?: number }): number {
  if (!usage) return 0;
  // GPT-4o 定价: $2.5/$10 per 1M input/output tokens
  let inputRate = 2.5, outputRate = 10;
  if (model.includes("gpt-4o-mini")) { inputRate = 0.15; outputRate = 0.6; }
  if (model.includes("o1") || model.includes("o3")) { inputRate = 15; outputRate = 60; }
  return ((usage.prompt_tokens || 0) / 1_000_000) * inputRate +
         ((usage.completion_tokens || 0) / 1_000_000) * outputRate;
}
