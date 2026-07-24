/**
 * OmniPM Orion — 诊断日志模块 (F10, v2.7.0)
 * 
 * 替代代码中的静默 catch 块，所有异常写入结构化诊断日志。
 * 日志自动脱敏：过滤 process.env.* / token / key / secret 等敏感模式。
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface DiagnosticEntry {
	timestamp: string;
	level: "info" | "warn" | "error";
	category: string;
	message: string;
	stack?: string;
}

// ═══════════════════════════════════════════════════════════
// 脱敏
// ═══════════════════════════════════════════════════════════

const SENSITIVE_PATTERNS = [
	/(?:token|key|secret|password|credential)s?\s*[:=]\s*\S+/gi,
	/-----BEGIN\s*(?:RSA|EC|DSA|OPENSSH)?\s*PRIVATE KEY-----[\s\S]*?-----END/s,
	/AKIA[0-9A-Z]{16}/g,       // AWS Access Key
	/sk-[a-zA-Z0-9]{32,}/g,    // OpenAI/Claude API Key
];

function sanitize(msg: string): string {
	let sanitized = msg;
	for (const pat of SENSITIVE_PATTERNS) {
		sanitized = sanitized.replace(pat, "[REDACTED]");
	}
	return sanitized;
}

// ═══════════════════════════════════════════════════════════
// 日志写入
// ═══════════════════════════════════════════════════════════

const RING_BUFFER_SIZE = 200;

function getLogPath(cwd: string): string {
	const dir = path.join(cwd, ".pi", "diagnostics");
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, "omnipm_diagnostics.json");
}

function readLog(cwd: string): DiagnosticEntry[] {
	try {
		const p = getLogPath(cwd);
		if (!fs.existsSync(p)) return [];
		return JSON.parse(fs.readFileSync(p, "utf-8"));
	} catch { return []; }
}

function writeLog(cwd: string, entries: DiagnosticEntry[]): void {
	const p = getLogPath(cwd);
	// 环形缓冲：只保留最近 N 条
	const trimmed = entries.length > RING_BUFFER_SIZE ? entries.slice(-RING_BUFFER_SIZE) : entries;
	fs.writeFileSync(p, JSON.stringify(trimmed, null, 2), "utf-8");
}

// ═══════════════════════════════════════════════════════════
// 公开 API
// ═══════════════════════════════════════════════════════════

/**
 * 写入一条诊断日志。
 * 替代原来的 `catch { /* ignore *​/ }` 静默吞噬。
 */
export function logDiagnostic(
	cwd: string,
	level: DiagnosticEntry["level"],
	category: string,
	message: string,
	error?: unknown,
): void {
	try {
		const entries = readLog(cwd);
		entries.push({
			timestamp: new Date().toISOString(),
			level,
			category,
			message: sanitize(message),
			stack: error instanceof Error ? sanitize(error.stack || error.message) : undefined,
		});
		writeLog(cwd, entries);
	} catch {
		// 诊断日志自身失败时静默处理（防止无限递归）
	}
}

/** 便捷方法 */
export const Diagnostics = {
	error: (cwd: string, category: string, message: string, error?: unknown) =>
		logDiagnostic(cwd, "error", category, message, error),
	warn: (cwd: string, category: string, message: string) =>
		logDiagnostic(cwd, "warn", category, message),
	info: (cwd: string, category: string, message: string) =>
		logDiagnostic(cwd, "info", category, message),
};
