/**
 * OmniPM v2.3.0 — 链式执行器（平台无关纯逻辑）
 * 
 * 从 index.ts 提取的链式调用核心逻辑。
 * 不依赖任何平台 API，可通过 Mock Runtime 测试。
 */

import type {
  AgentConfig,
  ChainOptions,
  ChainResult,
  ChainStepResult,
  ExpertResult,
} from "./interface.ts";

// ============================================================
// 常量
// ============================================================

export const MAX_CHAIN_STEPS = 10;
export const MAX_CHAIN_RETRIES = 3;

// ============================================================
// 失败分类
// ============================================================

export type FailureType =
  | "timeout"
  | "non_zero_exit"
  | "empty_output"
  | "low_quality"
  | "aborted"
  | "unknown";

export function classifyFailure(result: ExpertResult): FailureType {
  if (result.exitCode !== 0) {
    if (result.stderr?.includes("SIGTERM") || result.stderr?.includes("aborted")) {
      return "aborted";
    }
    if (result.stderr?.includes("timeout") || result.stderr?.includes("ETIMEDOUT")) {
      return "timeout";
    }
    return "non_zero_exit";
  }

  // 检查空输出
  const output = result.messages
    .filter(m => m.role === "assistant")
    .flatMap(m => m.content)
    .filter(c => c.type === "text")
    .map(c => c.text ?? "")
    .join("")
    .trim();

  if (!output) return "empty_output";
  if (output.length < 100 && !result.severity) return "low_quality";
  return "unknown";
}

// ============================================================
// 占位符替换
// ============================================================

export function substitutePlaceholders(
  template: string,
  previousOutput: string,
): string {
  let result = template;

  // {previous} — 完整前一步输出
  result = result.replace(/\{previous\}/g, previousOutput);

  // {previous:brief} — 前 2000 字符
  result = result.replace(
    /\{previous:brief\}/g,
    previousOutput.length > 2000
      ? previousOutput.slice(0, 2000) + "\n\n[... output truncated ...]"
      : previousOutput,
  );

  // {previous:summary} — 前 500 字符
  result = result.replace(
    /\{previous:summary\}/g,
    previousOutput.length > 500
      ? previousOutput.slice(0, 500) + "\n\n[... output truncated ...]"
      : previousOutput,
  );

  // {previous:severity} — 严重等级
  const severityMatch = previousOutput.match(/严重等级[：:]\s*(P[012])/);
  result = result.replace(
    /\{previous:severity\}/g,
    severityMatch ? severityMatch[1] : "unknown",
  );

  return result;
}

// ============================================================
// 重试任务构建
// ============================================================

export function buildRetryTask(
  originalTask: string,
  failureType: FailureType,
  attempt: number,
): string {
  const hints: Record<FailureType, string> = {
    timeout:
      "Previous attempt timed out. Please provide a more concise response.",
    non_zero_exit:
      "Previous attempt failed with a non-zero exit code. Please check the task and retry.",
    empty_output:
      "Previous attempt produced no output. Please ensure you respond to the task.",
    low_quality:
      "Previous output was too brief or lacked proper analysis. Please provide a more detailed response with severity levels (P0/P1/P2).",
    aborted:
      "Previous attempt was aborted. Please try again.",
    unknown:
      "Previous attempt had an unknown failure. Please retry the task.",
  };

  return [
    `## Retry (Attempt ${attempt}/${MAX_CHAIN_RETRIES})`,
    ``,
    `> ⚠️ ${hints[failureType]}`,
    ``,
    `### Original Task`,
    originalTask,
  ].join("\n");
}

// ============================================================
// 链式执行引擎
// ============================================================

export interface ChainStep {
  expert: string;
  task: string;
  context?: string;
}

export interface ChainExecutorOptions {
  /** Agent 列表（用于 lookup） */
  agents: AgentConfig[];
  /** 单步执行函数 */
  executeStep: (agent: AgentConfig, task: string, context?: string) => Promise<ExpertResult>;
  /** 强度提示词映射 */
  intensityHints?: Record<string, string>;
  /** 失败处理策略 */
  onError?: "stop" | "skip" | "retry";
  /** 最大重试次数 */
  maxRetries?: number;
}

/**
 * 执行链式调用
 * 
 * 按序执行 chainSteps，每步的 task 中 {previous} 占位符
 * 会被替换为前一步的实际输出。
 */
export async function executeChain(
  steps: ChainStep[],
  options: ChainExecutorOptions,
): Promise<ChainResult> {
  const { agents, executeStep, onError = "stop", maxRetries = MAX_CHAIN_RETRIES } = options;
  const results: ChainStepResult[] = [];
  let previousOutput = "";

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const agent = agents.find(a => a.name === step.expert);

    // 未知专家 — 构建哨兵结果
    if (!agent) {
      results.push({
        step,
        result: createEmptyResult(step.expert, `Unknown expert: "${step.expert}"`),
        success: false,
        failureType: "unknown" as FailureType,
        retryCount: 0,
      });
      previousOutput = `[Unknown expert: "${step.expert}"]`;
      if (onError === "stop") break;
      continue;
    }

    // 替换占位符
    const resolvedTask = substitutePlaceholders(step.task, previousOutput);

    let stepResult: ExpertResult | null = null;
    let retryCount = 0;
    let success = false;
    let failureType: FailureType | undefined;

    // 重试循环
    while (retryCount <= maxRetries) {
      const taskToRun =
        retryCount === 0
          ? resolvedTask
          : `${buildRetryTask(resolvedTask, failureType!, retryCount)}\n\n${resolvedTask}`;

      try {
        stepResult = await executeStep(agent, taskToRun, step.context);
      } catch {
        stepResult = createEmptyResult(step.expert, "Execution threw exception");
      }

      const output = stepResult.messages
        .filter(m => m.role === "assistant")
        .flatMap(m => m.content)
        .filter(c => c.type === "text")
        .map(c => c.text ?? "")
        .join("");

      if (stepResult.exitCode === 0 && output.trim().length > 0) {
        success = true;
        previousOutput = output;
        break;
      }

      retryCount++;
      failureType = classifyFailure(stepResult);

      if (onError === "stop") break;
      if (onError === "skip") break;
      // retry: continue the while loop
    }

    if (!success) {
      failureType = failureType ?? classifyFailure(stepResult!);

      if (onError === "stop") {
        results.push({ step, result: stepResult!, success: false, failureType, retryCount });
        break;
      }

      if (onError === "skip" || (onError === "retry" && retryCount >= maxRetries)) {
        results.push({
          step,
          result: stepResult!,
          success: false,
          failureType,
          retryCount,
        });
        previousOutput = `[Step skipped: ${failureType}]`;
        continue;
      }
    }

    results.push({ step, result: stepResult!, success: true, retryCount });
  }

  return summarizeChainResult(results);
}

// ============================================================
// 辅助函数
// ============================================================

function createEmptyResult(expert: string, error: string): ExpertResult {
  return {
    expert,
    task: "",
    exitCode: 1,
    messages: [],
    stderr: error,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    claimed_files: [],
  };
}

function summarizeChainResult(steps: ChainStepResult[]): ChainResult {
  const successCount = steps.filter(s => s.success).length;
  const failureCount = steps.filter(s => !s.success && s.failureType !== "unknown").length;
  const skippedCount = steps.filter(s => !s.success && s.retryCount > 0).length;

  const summaries = steps.map((s, i) => {
    const prefix = s.success ? "✅" : "❌";
    return `${prefix} Step ${i + 1}: ${s.step.expert} — ${s.step.task.slice(0, 80)}`;
  });

  const finalOutput = [
    `## Chain Execution: ${successCount}/${steps.length} completed`,
    ``,
    ...summaries,
    ``,
    `---`,
    `*Success: ${successCount} | Failed: ${failureCount} | Skipped: ${skippedCount}*`,
  ].join("\n");

  return { steps, finalOutput, successCount, failureCount };
}
