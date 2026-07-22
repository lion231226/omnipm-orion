/**
 * OmniPM v2.2.1 — DAG Utils 单元测试
 * 
 * 测试所有从 index.ts 提取的纯函数。
 */

import { describe, it, expect } from "vitest";
import {
  parseSeverity,
  getFinalOutput,
  isOutputTruncated,
  generateDAGSuggestion,
  getNodeById,
  getReadyNodes,
  getDAGProgress,
  validateDAGTopology,
  checkCircuitBreaker,
  getPlatformConfig,
  validatePlatformConfig,
  MAX_CORRECTIONS_PER_NODE,
} from "../../runtime/dag-utils.ts";
import type { DAGNode, DAGState, ExpertResult, Message } from "../../runtime/interface.ts";

// ============================================================
// 辅助函数
// ============================================================

function makeResult(overrides: Partial<ExpertResult> & { expert: string }): ExpertResult {
  return {
    expert: overrides.expert,
    task: "test task",
    exitCode: overrides.exitCode ?? 0,
    messages: overrides.messages ?? [
      { role: "assistant", content: [{ type: "text", text: "test output" }] },
    ],
    stderr: overrides.stderr ?? "",
    usage: overrides.usage ?? { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 200, turns: 1 },
    claimedFiles: overrides.claimedFiles ?? (overrides as any).claimed_files ?? [],
    severity: overrides.severity,
    stopReason: overrides.stopReason,
  };
}

function makeMessage(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function makeNode(overrides: Partial<DAGNode> & { nodeId: string }): DAGNode {
  return {
    nodeId: overrides.nodeId,
    name: overrides.name ?? `Node ${overrides.nodeId}`,
    status: overrides.status ?? "pending",
    dependsOn: overrides.dependsOn ?? [],
    correctionCount: overrides.correctionCount ?? 0,
    nodeType: overrides.nodeType,
  };
}

function makeState(nodes: DAGNode[]): DAGState {
  return {
    version: "2.2.1",
    projectName: "test",
    dagId: "test-uuid",
    nodes,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ============================================================
// parseSeverity
// ============================================================

describe("parseSeverity", () => {
  it("解析 P0 阻塞", () => {
    expect(parseSeverity("严重等级：P0")).toBe("P0");
    expect(parseSeverity("P0-阻塞 发现重大问题")).toBe("P0");
  });

  it("解析 P1 重要", () => {
    expect(parseSeverity("严重等级：P1")).toBe("P1");
    expect(parseSeverity("P1-重要 需要关注")).toBe("P1");
  });

  it("解析 P2 建议", () => {
    expect(parseSeverity("严重等级：P2")).toBe("P2");
    expect(parseSeverity("P2-建议 可选优化")).toBe("P2");
  });

  it("无等级时返回 undefined", () => {
    expect(parseSeverity("一切正常")).toBeUndefined();
  });
});

// ============================================================
// getFinalOutput
// ============================================================

describe("getFinalOutput", () => {
  it("v2.3.1(D-2): 拼接多条 assistant 消息", () => {
    const msg = getFinalOutput([makeMessage("first"), makeMessage("final")]);
    expect(msg).toBe("first\n\n---\n\nfinal");
  });

  it("单条 assistant 消息直接返回", () => {
    expect(getFinalOutput([makeMessage("only")])).toBe("only");
  });

  it("跳过 user 消息", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "question" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ];
    expect(getFinalOutput(msgs)).toBe("answer");
  });

  it("空消息列表返回空字符串", () => {
    expect(getFinalOutput([])).toBe("");
  });

  it("只有 user 消息返回空字符串", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];
    expect(getFinalOutput(msgs)).toBe("");
  });

  it("v2.3.1(D-2): 空文本消息被跳过", () => {
    const msgs: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "" }] },
      { role: "assistant", content: [{ type: "text", text: "valid" }] },
    ];
    expect(getFinalOutput(msgs)).toBe("valid");
  });
});

// ============================================================
// isOutputTruncated
// ============================================================

describe("isOutputTruncated", () => {
  it("stopReason=max_tokens → 截断", () => {
    const r = makeResult({
      expert: "backend",
      stopReason: "max_tokens",
    });
    expect(isOutputTruncated(r)).toBe(true);
  });

  it("stopReason=token_limit → 截断", () => {
    const r = makeResult({
      expert: "backend",
      stopReason: "token_limit",
    });
    expect(isOutputTruncated(r)).toBe(true);
  });

  it("stopReason=end_turn + 完整输出 → 非截断", () => {
    const r = makeResult({
      expert: "backend",
      stopReason: "end_turn",
    });
    expect(isOutputTruncated(r)).toBe(false);
  });

  it("未闭合代码块(fence) → 截断", () => {
    const r = makeResult({
      expert: "backend",
      messages: [{ role: "assistant", content: [{ type: "text", text: "## 评审结论\n\n发现以下问题:\n\n```go\nfunc main() {\n    db.Query(\"SELECT * FROM users\")\n    // 未闭合的代码块——" }] }],
    });
    expect(isOutputTruncated(r)).toBe(true);
  });

  it("完整输出 → 非截断", () => {
    const r = makeResult({
      expert: "backend",
      messages: [{ role: "assistant", content: [{ type: "text", text: "## 评审结论\n\n代码质量良好。\n\n**严重等级**：P2" }] }],
    });
    expect(isOutputTruncated(r)).toBe(false);
  });

  it("无stopReason + 短输出(<50) → 非截断", () => {
    const r = makeResult({
      expert: "backend",
      messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }],
    });
    expect(isOutputTruncated(r)).toBe(false);
  });
});

// ============================================================
// generateDAGSuggestion ★ 核心测试
// ============================================================

describe("generateDAGSuggestion", () => {
  it("全部通过 → complete", () => {
    const r = generateDAGSuggestion("node1", [
      makeResult({ expert: "qa", severity: "P2" }),
    ], 0);
    expect(r.action).toBe("complete");
  });

  it("exitCode != 0 → retry", () => {
    const r = generateDAGSuggestion("node1", [
      makeResult({ expert: "qa", exitCode: 1, messages: [] }),
    ], 0);
    expect(r.action).toBe("retry");
    expect(r.reason).toBe("专家执行失败");
  });

  // ★ v2.2.1: 空输出检测
  it("exitCode=0 + 空输出 → retry（v2.2.1）", () => {
    const r = generateDAGSuggestion("node1", [
      makeResult({ expert: "qa", exitCode: 0, messages: [] }),
    ], 0);
    expect(r.action).toBe("retry");
    expect(r.reason).toBe("专家无输出（空响应）");
  });

  it("exitCode=0 + 空格输出 → retry", () => {
    const r = generateDAGSuggestion("node1", [
      makeResult({
        expert: "qa",
        exitCode: 0,
        messages: [{ role: "assistant", content: [{ type: "text", text: "   \n  " }] }],
      }),
    ], 0);
    expect(r.action).toBe("retry");
  });

  it("P0 严重项 → retry", () => {
    const r = generateDAGSuggestion("node1", [
      makeResult({ expert: "security", severity: "P0" }),
    ], 0);
    expect(r.action).toBe("retry");
    expect(r.severity).toBe("P0");
  });

  it("P1 重要项 → retry", () => {
    const r = generateDAGSuggestion("node1", [
      makeResult({ expert: "qa", severity: "P1" }),
    ], 0);
    expect(r.action).toBe("retry");
    expect(r.severity).toBe("P1");
  });

  it("达到熔断阈值 → blocked", () => {
    const r = generateDAGSuggestion("node1", [
      makeResult({ expert: "qa", severity: "P0" }),
    ], MAX_CORRECTIONS_PER_NODE);
    expect(r.action).toBe("blocked");
  });

  it("文件验证——声称的文件不存在 → retry", () => {
    const fileExists = (f: string) => f !== "missing.md";
    const r = generateDAGSuggestion("node1", [
      makeResult({ expert: "qa", claimedFiles: ["missing.md"] }),
    ], 0, fileExists);
    expect(r.action).toBe("retry");
    expect(r.reason).toContain("声称写入");
  });

  it("文件验证——全部存在 → complete", () => {
    const fileExists = (_f: string) => true;
    const r = generateDAGSuggestion("node1", [
      makeResult({ expert: "qa", claimedFiles: ["ok.md"] }),
    ], 0, fileExists);
    expect(r.action).toBe("complete");
  });

  // v2.3.1(D-2): 截断检测
  it("stopReason=max_tokens → retry（v2.3.1 D-2）", () => {
    const r = generateDAGSuggestion("node1", [
      makeResult({ expert: "backend", stopReason: "max_tokens", messages: [
        { role: "assistant", content: [{ type: "text", text: "评审结果: 代码质量良好。但是" }] },
      ] }),
    ], 0);
    expect(r.action).toBe("retry");
    expect(r.reason).toContain("截断");
    expect(r.severity).toBe("P1");
  });

  it("输出截断 + 正常专家 → retry（混合场景）", () => {
    const r = generateDAGSuggestion("node1", [
      makeResult({ expert: "qa", severity: "P2" }),
      makeResult({ expert: "security", stopReason: "max_tokens" }),
    ], 0);
    expect(r.action).toBe("retry");
    expect(r.reason).toContain("security");
  });
});

// ============================================================
// DAG 状态查询
// ============================================================

describe("DAG 状态查询", () => {
  const nodes: DAGNode[] = [
    makeNode({ nodeId: "a", status: "done" }),
    makeNode({ nodeId: "b", status: "running", dependsOn: ["a"] }),
    makeNode({ nodeId: "c", status: "pending", dependsOn: ["a"] }),
    makeNode({ nodeId: "d", status: "pending", dependsOn: ["b", "c"] }),
    makeNode({ nodeId: "e", status: "pending", dependsOn: [] }),
  ];
  const state = makeState(nodes);

  it("getNodeById", () => {
    expect(getNodeById(state, "a")?.status).toBe("done");
    expect(getNodeById(state, "x")).toBeUndefined();
  });

  it("getReadyNodes — 依赖全部满足的 pending 节点", () => {
    const ready = getReadyNodes(state);
    expect(ready.map(n => n.nodeId).sort()).toEqual(["c", "e"]);
    // b: running, not pending
    // c: depends on a (done) → ready
    // d: depends on b (running) + c (pending) → not ready
    // e: no deps → ready
  });

  it("getDAGProgress", () => {
    const prog = getDAGProgress(state);
    expect(prog.done).toBe(1);
    expect(prog.total).toBe(5);
    expect(prog.pct).toBe(20);
  });

  it("空 DAG 进度为 0%", () => {
    const prog = getDAGProgress(makeState([]));
    expect(prog.pct).toBe(0);
  });
});

// ============================================================
// DAG 拓扑验证
// ============================================================

describe("validateDAGTopology", () => {
  it("合法 DAG 通过验证", () => {
    const nodes = [
      makeNode({ nodeId: "a" }),
      makeNode({ nodeId: "b", dependsOn: ["a"] }),
      makeNode({ nodeId: "c", dependsOn: ["a", "b"] }),
    ];
    const result = validateDAGTopology(nodes);
    expect(result.valid).toBe(true);
  });

  it("检测孤立依赖", () => {
    const nodes = [
      makeNode({ nodeId: "a", dependsOn: ["nonexistent"] }),
    ];
    const result = validateDAGTopology(nodes);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("不存在的节点");
  });

  it("检测循环依赖", () => {
    const nodes = [
      makeNode({ nodeId: "a", dependsOn: ["b"] }),
      makeNode({ nodeId: "b", dependsOn: ["a"] }),
    ];
    const result = validateDAGTopology(nodes);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("循环依赖");
  });

  it("复杂 DAG（菱形依赖）通过验证", () => {
    const nodes = [
      makeNode({ nodeId: "start" }),
      makeNode({ nodeId: "left", dependsOn: ["start"] }),
      makeNode({ nodeId: "right", dependsOn: ["start"] }),
      makeNode({ nodeId: "end", dependsOn: ["left", "right"] }),
    ];
    const result = validateDAGTopology(nodes);
    expect(result.valid).toBe(true);
  });
});

// ============================================================
// 熔断检查
// ============================================================

describe("checkCircuitBreaker", () => {
  it("未达阈值不熔断", () => {
    const node = makeNode({ nodeId: "a" });
    expect(checkCircuitBreaker(node, 0).blocked).toBe(false);
    expect(checkCircuitBreaker(node, 2).blocked).toBe(false);
  });

  it("达到阈值触发熔断", () => {
    const node = makeNode({ nodeId: "a", name: "测试节点" });
    const result = checkCircuitBreaker(node, MAX_CORRECTIONS_PER_NODE);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("熔断阈值");
  });
});

// ============================================================
// 平台配置
// ============================================================

describe("getPlatformConfig", () => {
  it("返回已知平台配置", () => {
    expect(getPlatformConfig("pi").toolCallFormat).toContain("run_experts");
    expect(getPlatformConfig("claude").constraints.length).toBeGreaterThan(0);
    expect(getPlatformConfig("gemini").subagentInstructions).toContain("1M+");
  });

  it("未知平台返回 unknown 配置", () => {
    const config = getPlatformConfig("chatgpt");
    expect(config.toolCallFormat).toContain("Markdown");
  });
});

describe("validatePlatformConfig", () => {
  it("完整配置无问题", () => {
    const config = getPlatformConfig("pi");
    expect(validatePlatformConfig(config)).toEqual([]);
  });

  it("缺失字段被检测", () => {
    const issues = validatePlatformConfig({
      prefix: "",
      toolCallFormat: "",
      gateTemplate: "",
      subagentInstructions: "",
      constraints: [],
    });
    expect(issues.length).toBe(3);
  });
});
