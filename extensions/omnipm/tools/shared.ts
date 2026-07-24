/**
 * OmniPM Orion — 共享符号层 (v2.7.0)
 * 
 * 零外部依赖的共享符号，被 run-experts 和 omni-dag 平级依赖。
 * 解决 v2.6 中 run-experts → omni-dag 的反向依赖问题。
 */

// ═══════════════════════════════════════════════════════════
// 模型注册表
// ═══════════════════════════════════════════════════════════

export interface ModelConfig {
	model: string;
	contextWindow: number;   // tokens
	maxOutputTokens: number;  // 建议最大输出
	description: string;
}

export const MODEL_REGISTRY: Record<string, ModelConfig> = {
	"deepseek-v4-pro": {
		model: "deepseek-v4-pro",
		contextWindow: 1_000_000,
		maxOutputTokens: 32_000,
		description: "DeepSeek V4 Pro — 1M上下文，适合深度分析",
	},
	"deepseek-v3": {
		model: "deepseek-v3",
		contextWindow: 128_000,
		maxOutputTokens: 8_000,
		description: "DeepSeek V3 — 128K上下文",
	},
	"claude-sonnet-4-20250514": {
		model: "claude-sonnet-4-20250514",
		contextWindow: 200_000,
		maxOutputTokens: 16_000,
		description: "Claude Sonnet 4 — 200K上下文",
	},
	"claude-opus-4-20250514": {
		model: "claude-opus-4-20250514",
		contextWindow: 200_000,
		maxOutputTokens: 32_000,
		description: "Claude Opus 4 — 200K上下文，最强分析能力",
	},
};

/** 从模型名模糊匹配注册表 */
export function getModelConfig(modelHint?: string): ModelConfig {
	if (modelHint && MODEL_REGISTRY[modelHint]) return MODEL_REGISTRY[modelHint];
	if (modelHint) {
		for (const [key, config] of Object.entries(MODEL_REGISTRY)) {
			if (modelHint.includes(key) || key.includes(modelHint)) return config;
		}
	}
	return { model: "", contextWindow: 1_000_000, maxOutputTokens: 16_000, description: "Pi 默认模型（自动检测）" };
}

// ═══════════════════════════════════════════════════════════
// F6: 原子写入（v2.7.0 新增 — UUID+Windows降级+排他锁）
// ═══════════════════════════════════════════════════════════

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

export function atomicWriteJSON<T>(
	filePath: string,
	data: T,
	options?: { expectedVersion?: number },
): void {
	const tmpPath = `${filePath}.${randomUUID()}.tmp`;
	const lockPath = `${filePath}.lock`;
	const backupPath = `${filePath}.bak`;

	const lockFd = fs.openSync(lockPath, "wx");
	try {
		if (options?.expectedVersion !== undefined && fs.existsSync(filePath)) {
			const current = JSON.parse(fs.readFileSync(filePath, "utf-8"));
			if ((current as any)._version !== options.expectedVersion) {
				throw new Error(`Version conflict: expected ${options.expectedVersion}, got ${(current as any)._version}`);
			}
		}

		const fd = fs.openSync(tmpPath, "w");
		fs.writeFileSync(fd, JSON.stringify(data, null, 2), "utf-8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);

		if (fs.existsSync(filePath)) {
			try {
				fs.renameSync(tmpPath, filePath);
			} catch {
				if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
				fs.renameSync(filePath, backupPath);
				try {
					fs.renameSync(tmpPath, filePath);
					fs.unlinkSync(backupPath);
				} catch (err2) {
					fs.renameSync(backupPath, filePath);
					throw new Error(`Atomic write failed, rolled back: ${err2}`);
				}
			}
		} else {
			fs.renameSync(tmpPath, filePath);
		}
	} finally {
		fs.closeSync(lockFd);
		try { fs.unlinkSync(lockPath); } catch {}
		try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
	}
}

/** 清理孤儿 tmp 文件（>60秒未修改） */
export function cleanupOrphanedTmpFiles(dirPath: string): void {
	const pattern = /\.tmp$/;
	try {
		for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
			if (!entry.isFile() || !pattern.test(entry.name)) continue;
			const fullPath = `${dirPath}/${entry.name}`;
			const age = Date.now() - fs.statSync(fullPath).mtimeMs;
			if (age > 60_000) {
				try { fs.unlinkSync(fullPath); } catch {}
			}
		}
	} catch {}
}
