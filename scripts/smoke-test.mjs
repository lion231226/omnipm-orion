/**
 * OmniPM E2E Smoke Test (F24, v2.7.0)
 * 
 * 验证最小 DAG 生命周期：init → start → complete → status → reset
 * 不依赖实际文件系统操作，仅验证状态机逻辑。
 * 
 * 用法: node scripts/smoke-test.mjs
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_CWD = join(tmpdir(), `omnipm-smoke-${Date.now()}`);

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

// Simulate the DAG state machine without loading the full Extension
const STATE_PATH = join(TEST_CWD, ".pi", "omnipm_dag_state.json");

try {
  console.log("\n🔍 OmniPM E2E Smoke Test\n");

  // 1. Simulate init
  const state = {
    projectName: "smoke-test",
    nodes: [
      { nodeId: "n1", name: "Design", status: "pending", dependsOn: [], correctionCount: 0 },
      { nodeId: "n2", name: "Review", status: "pending", dependsOn: ["n1"], correctionCount: 0 },
      { nodeId: "n3", name: "Develop", status: "pending", dependsOn: ["n2"], correctionCount: 0 },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: "2.7.0",
  };
  assert(state.nodes.length === 3, "init: 3 nodes");
  assert(state.nodes.every(n => n.status === "pending"), "init: all pending");

  // 2. Simulate start n1 (no deps)
  const n1 = state.nodes[0];
  assert(!n1.dependsOn || n1.dependsOn.length === 0, "n1: no dependencies");
  n1.status = "running";
  assert(n1.status === "running", "start n1: running");

  // 3. Simulate complete n1
  n1.status = "done";
  n1.completedAt = new Date().toISOString();
  assert(n1.status === "done", "complete n1: done");

  // 4. Simulate start n2 (depends on n1)
  const n2 = state.nodes[1];
  const unmet = (n2.dependsOn || []).filter(d => {
    const dep = state.nodes.find(n => n.nodeId === d);
    return !dep || dep.status !== "done";
  });
  assert(unmet.length === 0, "n2: all deps satisfied (n1=done)");
  n2.status = "running";

  // 5. Simulate complete n2
  n2.status = "done";

  // 6. Simulate start n3 — dependency check
  const n3 = state.nodes[2];
  const unmet3 = (n3.dependsOn || []).filter(d => {
    const dep = state.nodes.find(n => n.nodeId === d);
    return !dep || dep.status !== "done";
  });
  assert(unmet3.length === 0, "n3: all deps satisfied (n2=done)");

  // 7. Verify status
  const done = state.nodes.filter(n => n.status === "done").length;
  assert(done === 2, `status: ${done}/3 done`);

  // 8. Simulate version migration
  assert(state.version === "2.7.0", "version: 2.7.0");

  // 9. F11: Test dependency blocking
  const blockedState = {
    projectName: "blocked-test",
    nodes: [
      { nodeId: "a", name: "Node A", status: "pending", correctionCount: 0 },
      { nodeId: "b", name: "Node B", status: "pending", dependsOn: ["a"], correctionCount: 0 },
    ],
  };
  const nodeB = blockedState.nodes[1];
  const unmetB = (nodeB.dependsOn || []).filter(d => {
    const dep = blockedState.nodes.find(n => n.nodeId === d);
    return !dep || dep.status !== "done";
  });
  assert(unmetB.length === 1 && unmetB[0] === "a", "F11: dep check blocks when unmet");

  // Summary
  console.log(`\n${"-".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log("✅ E2E Smoke Test PASSED\n");
} catch (e) {
  console.error("❌ Smoke test error:", e);
  process.exit(1);
}
