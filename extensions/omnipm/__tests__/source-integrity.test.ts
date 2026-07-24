/**
 * OmniPM v2.3.1 — 源码完整性测试
 *
 * 防护目标：检测 `\n` 转义序列被展平为字面换行符的腐败问题。
 * 根因参考：D-1 — run_experts(security) 空输出
 *
 * 腐败机制：源码中 `\n`（反斜杠+n 两个 ASCII 字符）在文件传输/保存过程中
 * 被错误解释为字面 LF(0x0A)，导致 TypeScript 字符串字面量未正确闭合。
 *
 * 本测试扫描所有 .ts 和 .md 源文件，检测正则字符串 `"..."` 和 `'...'` 中
 * 的字面换行符（跨行字符串在 TypeScript 中非法，模板字面量 `` 除外）。
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================
// 配置
// ============================================================

const EXTENSION_DIR = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(EXTENSION_DIR, "..", "..");

/** 扫描目录列表 */
const SCAN_DIRS = [
  path.join(EXTENSION_DIR), // extensions/omnipm/
  path.join(PROJECT_ROOT, "modules"),
];

/** 文件扩展名过滤 */
const SCAN_EXTENSIONS = [".ts", ".md"];

/** 排除的目录模式 */
const EXCLUDE_PATTERNS = [
  /node_modules/,
  /\.git/,
  /__tests__/,
  /\.bak$/,
  /_archived/,
];

// ============================================================
// 检测器
// ============================================================

interface Corruption {
  file: string;
  line: number;
  column: number;
  snippet: string; // 上下文代码
  reason: string;
}

/**
 * 扫描单个文件中正则字符串内的字面换行符。
 *
 * 策略：
 * 1. 按行读取文件
 * 2. 检测以 `"` 或 `'` 开头、但未在同一行闭合的字符串
 * 3. 排除模板字面量 `` ` ``
 * 4. 排除注释行
 */
function scanFile(filePath: string): Corruption[] {
  const corruptions: Corruption[] = [];

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return corruptions; // 无法读取，跳过
  }

  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 跳过空行和纯注释行
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) {
      continue;
    }

    // 跳过 import 语句中的路径字符串（可能跨行但由 bundler 处理）
    if (trimmed.startsWith("import ")) continue;

    // ── 检测 1：双引号字符串 `.join("` 后紧跟换行 ──
    if (trimmed.includes('.join("') && !trimmed.includes('");') && !trimmed.includes('")')) {
      corruptions.push({
        file: path.relative(PROJECT_ROOT, filePath),
        line: i + 1,
        column: trimmed.indexOf('.join("') + 1,
        snippet: trimmed.slice(Math.max(0, trimmed.indexOf('.join("') - 10), trimmed.indexOf('.join("') + 30),
        reason: '`.join("` 字符串未在同一行闭合 —— \\n 转义可能被展平为字面换行符',
      });
    }

    // ── 检测 2：模板字面量中的 `.join("\n")` 退化检测 ──
    // 正常情况：`.join("\\n")` 或模板字面量中的 `.join("\n")`
    // 腐败情况：`.join("` 后紧跟字面换行
    const joinMatch = trimmed.match(/\.join\((["'`])/);
    if (joinMatch) {
      const quote = joinMatch[1];
      // 模板字面量 `` 中的换行是合法的，跳过
      if (quote === "`") continue;

      // 检查该行是否有闭合同类引号
      const afterJoin = trimmed.slice(trimmed.indexOf(".join("));
      const closeIdx = afterJoin.indexOf(quote, 2); // 跳过开引号
      if (closeIdx === -1) {
        // 字符串未闭合，但需要确认不是被其他代码截断
        // 如果行以 `);` 或 `)}` 结尾，那可能是字符串跨行
        if (!trimmed.endsWith("\\")) {
          corruptions.push({
            file: path.relative(PROJECT_ROOT, filePath),
            line: i + 1,
            column: (trimmed.indexOf(".join(") || 0) + 1,
            snippet: trimmed.slice(0, 120),
            reason: `正则字符串 ${quote}...${quote} 中检测到未闭合 —— 可能 \\n 被展平为字面换行`,
          });
        }
      }
    }

    // ── 检测 3：Markdown 文件 YAML frontmatter（仅检查文档开头第一个 ---）──
    // 注意：正文中的 --- 是合法的水平分隔线，不检查
    if (filePath.endsWith(".md") && i === 0 && trimmed === "---") {
      let hasClosing = false;
      for (let j = 1; j < Math.min(30, lines.length); j++) {
        if (lines[j].trim() === "---") {
          hasClosing = true;
          break;
        }
      }
      if (!hasClosing) {
        corruptions.push({
          file: path.relative(PROJECT_ROOT, filePath),
          line: 1,
          column: 1,
          snippet: "YAML frontmatter `---` 未在开头30行内闭合",
          reason: "Markdown YAML frontmatter 不完整",
        });
      }
    }
  }

  return corruptions;
}

/**
 * 递归收集指定目录中所有匹配的文件
 */
function collectFiles(dir: string): string[] {
  const files: string[] = [];

  if (!fs.existsSync(dir)) return files;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(PROJECT_ROOT, fullPath);

    // 排除检查
    if (EXCLUDE_PATTERNS.some(p => p.test(relativePath))) continue;

    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SCAN_EXTENSIONS.includes(ext)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

// ============================================================
// 测试套件
// ============================================================

describe("Source Code Integrity (D-1 Prevention)", () => {
  const allFiles: string[] = [];
  for (const dir of SCAN_DIRS) {
    allFiles.push(...collectFiles(dir));
  }

  it(`should scan ${allFiles.length} source files without finding corruption`, () => {
    const allCorruptions: Corruption[] = [];

    for (const file of allFiles) {
      const corruptions = scanFile(file);
      allCorruptions.push(...corruptions);
    }

    if (allCorruptions.length > 0) {
      const report = allCorruptions
        .map(c => `  ${c.file}:${c.line}:${c.column} — ${c.reason}\n    → ${c.snippet}`)
        .join("\n");

      expect.fail(
        `Found ${allCorruptions.length} potential escape sequence corruption(s):\n${report}\n\n` +
        `This is the exact bug pattern that caused D-1 (run_experts empty output).\n` +
        `Check if \\n escape sequences were flattened to literal newlines during file transfer.`
      );
    }
  });

  it("should not have unterminated regular strings in index.ts", () => {
    const indexPath = path.join(EXTENSION_DIR, "index.ts");
    if (!fs.existsSync(indexPath)) {
      // Extension dir might not exist in CI without the full project
      return;
    }

    const content = fs.readFileSync(indexPath, "utf-8");
    const lines = content.split("\n");

    const issues: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check: double-quoted string containing literal newline before closing quote
      // Pattern: ".join(" followed by newline, then "); on next line
      if (line.includes('.join("') && !line.includes('");') && !line.includes('")')) {
        // Check next line for closing
        if (i + 1 < lines.length && lines[i + 1].trim().startsWith('");')) {
          issues.push(
            `Line ${i + 1}: .join("\\n") appears corrupted — ` +
            `opening quote at line ${i + 1}, closing at line ${i + 2}`
          );
        }
      }
    }

    expect(issues).toEqual([]);
  });

  it("should have all .join() calls with proper escape sequences", () => {
    const indexPath = path.join(EXTENSION_DIR, "index.ts");
    if (!fs.existsSync(indexPath)) return;

    const content = fs.readFileSync(indexPath, "utf-8");

    // Count .join(" occurrences that should be valid
    const joinCalls = content.match(/\.join\("/g);
    const validJoinCalls = content.match(/\.join\("\\n"\)/g);

    // Not all .join(" are .join("\n") — some are .join(" ") or .join(", ")
    // But .join(" without closing ") on the same line = potential corruption
    const lines = content.split("\n");
    const openJoinLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('.join("') && !lines[i].includes('");') && !lines[i].includes('")')) {
        openJoinLines.push(i + 1);
      }
    }

    expect(openJoinLines).toEqual([]);
  });
});
