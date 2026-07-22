/**
 * OmniPM v2.3.0 — Chain Executor 单元测试
 */

import { describe, it, expect } from "vitest";
import {
  classifyFailure,
  substitutePlaceholders,
  buildRetryTask,
  executeChain,
  type ChainStep,
  type FailureType,
  MAX_CHAIN_STEPS,
} from "../../runtime/chain-executor.ts";
import type { AgentConfig, ExpertResult } from "../../runtime/interface.ts";

// ============================================================
// 辅助
// ============================================================

function makeAgent(name: string): AgentConfig {
  return { name, systemPrompt: `You are ${name}`, scope: "omnipm" };
}

function makeResult(exitCode: number, output: string): ExpertResult {
  return {
    expert: "test",
    task: "",
    exitCode,
    messages: output ? [{ role: "assistant", content: [{ type: "text", text: output }] }] : [],
    stderr: "",
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 200, turns: 1 },
    claimed_files: [],
  };
}

// ============================================================
// classifyFailure
// ============================================================

describe("classifyFailure", () => {
  it("non_zero_exit", () => {
    const r = makeResult(1, "");
    expect(classifyFailure(r)).toBe("non_zero_exit");
  });

  it("SIGTERM → aborted", () => {
    const r: ExpertResult = { ...makeResult(1, ""), stderr: "SIGTERM received" };
    expect(classifyFailure(r)).toBe("aborted");
  });

  it("timeout → timeout", () => {
    const r: ExpertResult = { ...makeResult(1, ""), stderr: "ETIMEDOUT" };
    expect(classifyFailure(r)).toBe("timeout");
  });

  it("空输出 → empty_output", () => {
    const r = makeResult(0, "");
    expect(classifyFailure(r)).toBe("empty_output");
  });

  it("短输出 + 无严重等级 → low_quality", () => {
    const r = makeResult(0, "ok");
    expect(classifyFailure(r)).toBe("low_quality");
  });

  it("正常输出 → unknown (不是失败)", () => {
    const r: ExpertResult = {
      ...makeResult(0, "This is a full analysis with sufficient length."),
      severity: "P2",
    };
    expect(classifyFailure(r)).toBe("unknown");
  });
});

// ============================================================
// substitutePlaceholders
// ============================================================

describe("substitutePlaceholders", () => {
  it("替换 {previous}", () => {
    const result = substitutePlaceholders("Step says: {previous}", "hello world");
    expect(result).toBe("Step says: hello world");
  });

  it("替换 {previous:severity}", () => {
    const prev = "严重等级：P0\n发现问题";
    const result = substitutePlaceholders("上一轮: {previous:severity}", prev);
    expect(result).toBe("上一轮: P0");
  });

  it("{previous:brief} 截断", () => {
    const long = "a".repeat(3000);
    const result = substitutePlaceholders("Brief: {previous:brief}", long);
    expect(result.length).toBeLessThan(3000);
    expect(result).toContain("truncated");
  });

  it("多占位符同时替换", () => {
    const prev = "严重等级：P1\n分析完成";
    const result = substitutePlaceholders(
      "Full: {previous}\nSev: {previous:severity}",
      prev,
    );
    expect(result).toContain("Full: 严重等级：P1\n分析完成");
    expect(result).toContain("Sev: P1");
  });
});

// ============================================================
// buildRetryTask
// ============================================================

describe("buildRetryTask", () => {
  it("包含失败原因和重试提示", () => {
    const task = buildRetryTask("original task", "timeout", 2);
    expect(task).toContain("Retry (Attempt 2/3)");
    expect(task).toContain("timed out");
    expect(task).toContain("original task");
  });

  it("所有失败类型都有对应提示", () => {
    const types: FailureType[] = ["timeout", "non_zero_exit", "empty_output", "low_quality", "aborted", "unknown"];
    for (const ft of types) {
      const task = buildRetryTask("test", ft, 1);
      expect(task).toContain("Retry");
    }
  });
});

// ============================================================
// executeChain
// ============================================================

describe("executeChain", () => {
  const agents = [
    makeAgent("qa"),
    makeAgent("security"),
  ];

  it("全部成功执行", async () => {
    const steps: ChainStep[] = [
      { expert: "qa", task: "Review {previous}" },
      { expert: "security", task: "Audit {previous}" },
    ];

    let callCount = 0;
    const result = await executeChain(steps, {
      agents,
      executeStep: async (_agent, _task) => {
        callCount++;
        return makeResult(0, `Step ${callCount} output`);
      },
    });

    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);
  });

  it("未知专家 → 跳过或停止", async () => {
    const steps: ChainStep[] = [
      { expert: "nonexistent", task: "do something" },
    ];

    const result = await executeChain(steps, {
      agents,
      executeStep: async () => makeResult(0, "ok"),
      onError: "skip",
    });

    expect(result.successCount).toBe(0);
    expect(result.steps[0].success).toBe(false);
  });

  it("{previous} 上下文正确传递", async () => {
    const steps: ChainStep[] = [
      { expert: "qa", task: "Review this" },
      { expert: "security", task: "Previous said: {previous}" },
    ];

    let callCount = 0;
    const outputs = ["QA found 3 issues [P1]", ""];

    const result = await executeChain(steps, {
      agents,
      executeStep: async () => {
        const out = outputs[callCount];
        callCount++;
        return makeResult(0, out);
      },
    });

    expect(result.successCount).toBeGreaterThanOrEqual(1);
  });

  it("失败 → stop 策略", async () => {
    const steps: ChainStep[] = [
      { expert: "qa", task: "step 1" },
      { expert: "security", task: "step 2" },
      { expert: "qa", task: "step 3" },
    ];

    const result = await executeChain(steps, {
      agents,
      executeStep: async (_agent, task) => {
        if (task.includes("step 2")) return makeResult(1, ""); // fail
        return makeResult(0, "ok");
      },
      onError: "stop",
    });

    expect(result.steps.length).toBe(2); // stopped after step 2
    expect(result.steps[1].success).toBe(false);
  });

  it("失败 → skip 策略继续执行", async () => {
    const steps: ChainStep[] = [
      { expert: "qa", task: "step 1" },
      { expert: "security", task: "step 2" },
      { expert: "qa", task: "step 3" },
    ];

    const result = await executeChain(steps, {
      agents,
      executeStep: async (_agent, task) => {
        if (task.includes("step 2")) return makeResult(1, ""); // fail
        return makeResult(0, "ok");
      },
      onError: "skip",
    });

    expect(result.steps.length).toBe(3);
    expect(result.successCount).toBe(2);
  });
});
