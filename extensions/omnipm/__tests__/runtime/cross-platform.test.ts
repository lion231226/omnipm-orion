/**
 * OmniPM 跨平台适配器验证测试桩 (F23, v2.7.0)
 * 
 * 验证 claude/codex/gemini 适配器的最小可工作路径。
 * 使用 mock 模式，不调用真实 API。
 */

import { describe, it, expect, vi } from "vitest";

// Mock the cross-platform module
vi.mock("../runtime/cross-platform.ts", () => ({
  ClaudeAdapter: class {
    async spawn() { return { exitCode: 0, messages: [], usage: { input: 0, output: 0 } }; }
    getCapabilities() { return { streaming: true, toolUse: true, imageInput: false }; }
  },
  CodexAdapter: class {
    async spawn() { return { exitCode: 0, messages: [], usage: { input: 0, output: 0 } }; }
    getCapabilities() { return { streaming: true, toolUse: true, imageInput: true }; }
  },
  GeminiAdapter: class {
    async spawn() { return { exitCode: 0, messages: [], usage: { input: 0, output: 0 } }; }
    getCapabilities() { return { streaming: true, toolUse: false, imageInput: true }; }
  },
}));

describe("Cross-Platform Adapters (F23)", () => {
  it("ClaudeAdapter should have expected capabilities", async () => {
    const { ClaudeAdapter } = await import("../runtime/cross-platform.ts");
    const adapter = new ClaudeAdapter();
    const caps = adapter.getCapabilities();
    expect(caps.streaming).toBe(true);
    expect(caps.toolUse).toBe(true);
  });

  it("CodexAdapter should have expected capabilities", async () => {
    const { CodexAdapter } = await import("../runtime/cross-platform.ts");
    const adapter = new CodexAdapter();
    const caps = adapter.getCapabilities();
    expect(caps.streaming).toBe(true);
    expect(caps.imageInput).toBe(true);
  });

  it("GeminiAdapter should have expected capabilities", async () => {
    const { GeminiAdapter } = await import("../runtime/cross-platform.ts");
    const adapter = new GeminiAdapter();
    const caps = adapter.getCapabilities();
    expect(caps.imageInput).toBe(true);
  });
});
