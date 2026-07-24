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
  scoreExpertQuality,
  aggregateQualityScores,
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
    expect(getPlatformConfig("codex").subagentInstructions).toContain("OpenAI");
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

// ============================================================
// v2.5.0: 专家输出质量评分测试（DEV-4.1）
// ============================================================

describe("scoreExpertQuality", () => {
  const goodOutput = `### 🔒 安全专家 评审意见

#### 【思考过程】
以攻击者视角审视系统设计，发现 SQL 注入风险。

#### 【威胁模型摘要】
| 威胁场景 | STRIDE 分类 | 风险等级 |
|---------|------------|---------|
| SQL注入 | Tampering | 🔴 高 |

#### 【建议/风险点】
1. **SQL注入防御**：使用参数化查询替代字符串拼接，因为当前代码直接拼接用户输入到 SQL 语句
2. **认证安全**：JWT token 未设置过期时间，建议改为 24h 有效期
3. **数据加密**：敏感字段（密码）使用 bcrypt 哈希，当前使用 MD5 不安全
4. **CORS 配置**：当前 'Access-Control-Allow-Origin: *' 过于宽松，应限制为可信域名
5. **日志安全**：错误日志中泄露了用户 token，需要脱敏处理

**严重等级**：P0`;

  const minimalOutput = `### 评审意见

1. 代码有一些问题
2. 需要改进

严重等级：P2`;

  const emptyOutput = "";

  const truncatedOutput = `### 评审意见\n\n部分分析...`;

  it("高质量输出应获得 A 或 B 评级", () => {
    const score = scoreExpertQuality({
      expert: "security",
      task: "审查登录模块",
      output: goodOutput,
      intensity: "DEEP",
    });
    expect(score.total).toBeGreaterThanOrEqual(70);
    expect(["A", "B"]).toContain(score.grade);
    expect(score.dimensions.structure).toBeGreaterThanOrEqual(30);
    expect(score.dimensions.completeness).toBeGreaterThanOrEqual(20);
  });

  it("空输出应获得 F 评级", () => {
    const score = scoreExpertQuality({
      expert: "security",
      task: "审查",
      output: emptyOutput,
    });
    expect(score.total).toBeLessThan(40);
    expect(score.grade).toBe("F");
    expect(score.issues.length).toBeGreaterThan(0);
  });

  it("简短输出分数较低", () => {
    const score = scoreExpertQuality({
      expert: "backend",
      task: "审查代码",
      output: minimalOutput,
    });
    expect(score.total).toBeLessThan(70);
    expect(score.dimensions.depth).toBeLessThan(10);
  });

  it("max_tokens 截断应受到惩罚", () => {
    const normalScore = scoreExpertQuality({
      expert: "architect",
      task: "架构评审",
      output: goodOutput,
    });
    const truncatedScore = scoreExpertQuality({
      expert: "architect",
      task: "架构评审",
      output: truncatedOutput,
      stopReason: "max_tokens",
    });
    expect(truncatedScore.total).toBeLessThan(normalScore.total);
  });

  it("LIGHT 强度降低期望", () => {
    const standardScore = scoreExpertQuality({
      expert: "market-analyst",
      task: "市场分析",
      output: minimalOutput,
      intensity: "STANDARD",
    });
    const lightScore = scoreExpertQuality({
      expert: "market-analyst",
      task: "市场分析",
      output: minimalOutput,
      intensity: "LIGHT",
    });
    // LIGHT 模式下结构/深度期望降低
    expect(lightScore.dimensions.structure).toBeLessThanOrEqual(standardScore.dimensions.structure);
  });

  it("包含专业术语的输出深度评分更高", () => {
    const withoutTerms = scoreExpertQuality({
      expert: "architect",
      task: "评审",
      output: "这个设计还可以，有一些改进空间。建议优化性能。",
    });
    const withTerms = scoreExpertQuality({
      expert: "architect",
      task: "评审",
      output: "微服务架构存在耦合问题，建议引入消息队列解耦，使用 CQRS 模式分离读写。需要评估分布式事务的一致性方案。",
    });
    expect(withTerms.dimensions.depth).toBeGreaterThan(withoutTerms.dimensions.depth);
  });

  it("4 个维度分数总和等于 total", () => {
    const score = scoreExpertQuality({
      expert: "qa",
      task: "测试策略评审",
      output: goodOutput,
    });
    const dimSum = score.dimensions.structure + score.dimensions.completeness +
      score.dimensions.depth + score.dimensions.actionability;
    // total 可能被 cap 在 100，所以检查 ≤ total 或 dimSum === total (capped)
    expect(dimSum === score.total || (dimSum > 100 && score.total === 100)).toBe(true);
  });
});

describe("aggregateQualityScores", () => {
  it("空数组返回零值", () => {
    const result = aggregateQualityScores([]);
    expect(result.average).toBe(0);
  });

  it("正确计算平均分和分布", () => {
    const scores = [
      { total: 85, dimensions: { structure: 35, completeness: 25, depth: 15, actionability: 10 }, grade: "A" as const, issues: [], scoredAt: "" },
      { total: 75, dimensions: { structure: 30, completeness: 22, depth: 13, actionability: 10 }, grade: "B" as const, issues: [], scoredAt: "" },
      { total: 55, dimensions: { structure: 20, completeness: 18, depth: 10, actionability: 7 }, grade: "C" as const, issues: [], scoredAt: "" },
      { total: 45, dimensions: { structure: 15, completeness: 15, depth: 8, actionability: 7 }, grade: "D" as const, issues: [], scoredAt: "" },
    ];
    const result = aggregateQualityScores(scores);
    expect(result.average).toBe(65);
    expect(result.gradeDistribution).toEqual({ A: 1, B: 1, C: 1, D: 1 });
  });

  it("识别最弱维度", () => {
    const scores = [
      { total: 80, dimensions: { structure: 35, completeness: 25, depth: 10, actionability: 10 }, grade: "B" as const, issues: [], scoredAt: "" },
      { total: 80, dimensions: { structure: 35, completeness: 25, depth: 10, actionability: 10 }, grade: "B" as const, issues: [], scoredAt: "" },
    ];
    const result = aggregateQualityScores(scores);
    expect(result.worstDimension).toBe("depth");
  });
});
