/**
 * OmniPM Extension 完整性校验 (F27, v2.7.0)
 * 
 * 用法: node scripts/checksum.js [--verify]
 *   --verify: 对比 .pi/extension.checksum 验证完整性
 */

const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const EXT_DIR = join(__dirname, "..", "extensions", "omnipm");
const CHECKSUM_FILE = join(__dirname, "..", ".pi", "extension.checksum");

const FILES = [
  "index.ts",
  "tools/shared.ts",
  "runtime/diagnostics.ts",
  "runtime/migrations.ts",
  "runtime/events.ts",
  "runtime/dag-utils.ts",
  "runtime/dag-context.ts",
  "runtime/cdl.ts",
  "runtime/chain-executor.ts",
  "runtime/condition-branch.ts",
  "runtime/cross-platform.ts",
  "runtime/retrospective.ts",
  "runtime/mock.ts",
  "runtime/pi-adapter.ts",
  "runtime/interface.ts",
  "agents.ts",
];

function checksum(filePath) {
  const content = readFileSync(filePath, "utf-8");
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

const verify = process.argv.includes("--verify");

if (verify && existsSync(CHECKSUM_FILE)) {
  const stored = JSON.parse(readFileSync(CHECKSUM_FILE, "utf-8"));
  let allOk = true;
  for (const f of FILES) {
    const fp = join(EXT_DIR, f);
    if (!existsSync(fp)) { console.log(`❌ MISSING: ${f}`); allOk = false; continue; }
    const hash = checksum(fp);
    if (stored[f] !== hash) { console.log(`❌ CHANGED: ${f} (${stored[f]} → ${hash})`); allOk = false; }
    else console.log(`✅ ${f}`);
  }
  process.exit(allOk ? 0 : 1);
} else {
  const hashes = {};
  for (const f of FILES) {
    const fp = join(EXT_DIR, f);
    if (!existsSync(fp)) { console.log(`⚠️ SKIP (missing): ${f}`); continue; }
    hashes[f] = checksum(fp);
    console.log(`${hashes[f]}  ${f}`);
  }
  if (!verify) {
    writeFileSync(CHECKSUM_FILE, JSON.stringify(hashes, null, 2), "utf-8");
    console.log(`\n✅ Checksums written to ${CHECKSUM_FILE}`);
  }
}
