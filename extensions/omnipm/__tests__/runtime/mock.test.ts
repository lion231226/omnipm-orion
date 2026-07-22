/**
 * OmniPM v2.2.0 — Mock Runtime 单元测试
 * 
 * 验证 Mock 运行时实现的正确性，
 * 确保所有接口方法按预期工作。
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createMockRuntime,
  MockFileSystem,
  MockSubagentRuntime,
  MockStorage,
  MockEventBus,
  MockUserInterface,
} from "../../runtime/mock.ts";
import type { DAGNode, DAGState } from "../../runtime/interface.ts";

// ============================================================
// MockFileSystem 测试
// ============================================================

describe("MockFileSystem", () => {
  let fs: MockFileSystem;

  beforeEach(() => {
    fs = new MockFileSystem();
  });

  it("写入和读取文件", async () => {
    await fs.write("/test/file.md", "# Hello");
    const content = await fs.read("/test/file.md");
    expect(content).toBe("# Hello");
  });

  it("检查文件存在性", async () => {
    fs.setFile("/test/exists.md", "content");
    expect(await fs.exists("/test/exists.md")).toBe(true);
    expect(await fs.exists("/test/nonexistent.md")).toBe(false);
  });

  it("删除文件后不存在", async () => {
    fs.setFile("/test/to-delete.md", "bye");
    await fs.unlink("/test/to-delete.md");
    expect(await fs.exists("/test/to-delete.md")).toBe(false);
  });

  it("setExists 覆盖默认行为", async () => {
    fs.setExists("/test/custom.md", true);
    expect(await fs.exists("/test/custom.md")).toBe(true);
    // 未预设的仍按文件 Map 判断
    expect(await fs.exists("/test/never-set.md")).toBe(false);
  });

  it("atomicWrite 行为与 write 一致", async () => {
    await fs.atomicWrite("/test/atomic.md", "atomic content");
    expect(await fs.read("/test/atomic.md")).toBe("atomic content");
  });
});

// ============================================================
// MockSubagentRuntime 测试
// ============================================================

describe("MockSubagentRuntime", () => {
  let subagent: MockSubagentRuntime;

  beforeEach(() => {
    subagent = new MockSubagentRuntime();
  });

  it("默认 spawn 返回成功结果", async () => {
    const result = await subagent.spawn(
      { name: "qa", systemPrompt: "", scope: "omnipm" },
      "test task",
    );
    expect(result.exitCode).toBe(0);
    expect(result.expert).toBe("mock");
    expect(result.messages).toHaveLength(1);
  });

  it("setResultOverride 覆盖默认行为", async () => {
    const custom = MockSubagentRuntime.successResult("architect", "custom output", "P1");
    subagent.setResultOverride(custom);

    const result = await subagent.spawn(
      { name: "architect", systemPrompt: "", scope: "omnipm" },
      "task",
    );
    expect(result.expert).toBe("architect");
    expect(result.severity).toBe("P1");
  });

  it("setResults 按顺序返回预设结果", async () => {
    subagent.setResults([
      MockSubagentRuntime.successResult("qa", "first"),
      MockSubagentRuntime.failureResult("security", "error"),
      MockSubagentRuntime.successResult("architect", "third"),
    ]);

    const r1 = await subagent.spawn({ name: "qa", systemPrompt: "", scope: "omnipm" }, "");
    expect(r1.expert).toBe("qa");

    const r2 = await subagent.spawn({ name: "security", systemPrompt: "", scope: "omnipm" }, "");
    expect(r2.exitCode).toBe(1);
    expect(r2.stderr).toBe("error");

    const r3 = await subagent.spawn({ name: "architect", systemPrompt: "", scope: "omnipm" }, "");
    expect(r3.expert).toBe("architect");
  });

  it("spawnParallel 并行执行多个代理", async () => {
    subagent.setResults([
      MockSubagentRuntime.successResult("qa", "ok"),
      MockSubagentRuntime.successResult("architect", "ok"),
    ]);

    const results = await subagent.spawnParallel([
      { agent: { name: "qa", systemPrompt: "", scope: "omnipm" }, task: "t1" },
      { agent: { name: "architect", systemPrompt: "", scope: "omnipm" }, task: "t2" },
    ]);

    expect(results).toHaveLength(2);
    results.forEach(r => expect(r.exitCode).toBe(0));
  });

  it("successResult 工厂正确设置所有字段", () => {
    const r = MockSubagentRuntime.successResult("qa", "P0 issue", "P0");
    expect(r.expert).toBe("qa");
    expect(r.exitCode).toBe(0);
    expect(r.severity).toBe("P0");
    expect(r.usage.cost).toBe(0.01);
    expect(r.claimedFiles).toEqual([]);
  });

  it("failureResult 工厂正确设置错误信息", () => {
    const r = MockSubagentRuntime.failureResult("security", "timeout");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("timeout");
    expect(r.messages).toHaveLength(0);
  });

  it("getCapabilities 返回平台能力", () => {
    const caps = subagent.getCapabilities();
    expect(caps.platform).toBe("pi");
    expect(caps.processIsolation).toBe(true);
    expect(caps.maxConcurrency).toBe(4);
  });

  it("自定义 capabilities", () => {
    const sa = new MockSubagentRuntime({ platform: "claude", maxConcurrency: 1 });
    expect(sa.getCapabilities().platform).toBe("claude");
    expect(sa.getCapabilities().maxConcurrency).toBe(1);
  });
});

// ============================================================
// MockEventBus 测试
// ============================================================

describe("MockEventBus", () => {
  let events: MockEventBus;

  beforeEach(() => {
    events = new MockEventBus();
  });

  it("emit 后 assertEmitted 可验证", () => {
    events.emit("test:event", { key: "value" });
    expect(events.assertEmitted("test:event", { key: "value" })).toBe(true);
    expect(events.assertEmitted("nonexistent")).toBe(false);
  });

  it("注册的回调在 emit 时被调用", () => {
    let called = false;
    events.on("custom", () => { called = true; });
    events.emit("custom", {});
    expect(called).toBe(true);
  });
});

// ============================================================
// MockStorage 测试
// ============================================================

describe("MockStorage", () => {
  let storage: MockStorage;

  beforeEach(() => {
    storage = new MockStorage();
  });

  it("set 后 get 返回相同值", async () => {
    await storage.set("key", { a: 1 });
    expect(await storage.get("key")).toEqual({ a: 1 });
  });

  it("delete 后 get 返回 null", async () => {
    await storage.set("key", "value");
    await storage.delete("key");
    expect(await storage.get("key")).toBeNull();
  });

  it("loadDAGState / saveDAGState 使用 dag_state 键", async () => {
    const state: DAGState = {
      version: "2.2.0",
      projectName: "test",
      dagId: "uuid-1",
      nodes: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await storage.saveDAGState("test", state);
    const loaded = await storage.loadDAGState("test");
    expect(loaded?.projectName).toBe("test");
  });
});

// ============================================================
// MockUserInterface 测试
// ============================================================

describe("MockUserInterface", () => {
  let ui: MockUserInterface;

  beforeEach(() => {
    ui = new MockUserInterface();
  });

  it("setConfirmResponses 控制确认行为", async () => {
    ui.setConfirmResponses([false, true, true]);
    expect(await ui.confirm("q1")).toBe(false);
    expect(await ui.confirm("q2")).toBe(true);
    expect(await ui.confirm("q3")).toBe(true);
  });

  it("notify 记录通知", () => {
    ui.notify("test message", "warning");
    expect(ui.notifications).toHaveLength(1);
    expect(ui.notifications[0].level).toBe("warning");
  });
});

// ============================================================
// createMockRuntime 集成测试
// ============================================================

describe("createMockRuntime", () => {
  it("创建完整 mock 运行时", () => {
    const { ctx, fs, subagent, storage, events, ui } = createMockRuntime("pi");

    expect(ctx.platform).toBe("pi");
    expect(ctx.capabilities.processIsolation).toBe(true);
    expect(ctx.subagent).toBe(subagent);
    expect(ctx.fs).toBe(fs);
    expect(ctx.storage).toBe(storage);
    expect(ctx.events).toBe(events);
    expect(ctx.ui).toBe(ui);
  });

  it("创建不同平台的 mock 运行时", () => {
    const { ctx } = createMockRuntime("claude");
    expect(ctx.platform).toBe("claude");
  });

  it("支持部分覆盖", () => {
    const { ctx, fs } = createMockRuntime("pi", {
      fs: { cwd: "/custom/cwd" } as any,
    });
    expect(ctx.fs.cwd).toBe("/custom/cwd");
  });
});
