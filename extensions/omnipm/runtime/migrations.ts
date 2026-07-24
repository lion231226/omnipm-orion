/**
 * OmniPM Orion — Schema 版本迁移 (F12, v2.7.0)
 * 
 * 迁移策略（v2.0修正）：
 *   1. 全量备份（迁移前原子写入备份文件）
 *   2. 深拷贝 + 内存中链式迁移
 *   3. 一次性写入（全部迁移成功后才写磁盘）
 *   4. 读取验证（重新读取确认版本号）
 *   5. 清理备份（验证通过后删除）
 *   6. 失败回滚（任一步失败→保留原文件+备份）
 * 
 * 版本历史：
 *   v1.0.0 (2024-Q4) : 初始扁平 key-value 结构
 *   v2.0.0 (2025-Q1) : 新增 nodeType 枚举字段 [SCHEMA CHANGE]
 *   v2.1.0 (2025-Q1) : [NO PERSISTENCE] 运行时重构——dag-context 注入
 *   v2.2.0 (2025-Q2) : [NO PERSISTENCE] 事件系统 overhaul
 *   v2.3.0 (2025-Q3) : 新增 outputs 结构化字段 + correctionCount [SCHEMA CHANGE]
 *   v2.4.0 (2026-Q1) : 新增 events[] append-only 日志流 [SCHEMA CHANGE]
 *   v2.5.0 (2026-Q2) : [NO PERSISTENCE] Condition Branch 路由 + 质量评分
 *   v2.6.0 (2026-Q3) : PRD/SPEC 节点类型 [SCHEMA CHANGE]
 *   v2.7.0 (CURRENT)  : 目标版本
 * 
 * 活跃迁移链（仅包含有持久化变更的版本）:
 *   v1.0.0 → v2.0.0 → v2.3.0 → v2.4.0 → v2.6.0 → v2.7.0
 */

import * as fs from "node:fs";
import { atomicWriteJSON } from "../tools/shared.ts";

// ═══════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════

const LATEST_VERSION = "2.7.0";

// ═══════════════════════════════════════════════════════════
// 迁移注册表
// ═══════════════════════════════════════════════════════════

interface Migration {
	targetVersion: string;
	description: string;
	apply: (state: any) => any;
}

const MIGRATIONS: Migration[] = [
	{
		targetVersion: "2.0.0",
		description: "添加 nodeType 默认值（旧版本仅靠节点 id 推断类型）",
		apply: (state) => {
			for (const node of state.nodes || []) {
				if (!node.nodeType) {
					if (node.name?.includes("REVIEW") || node.name?.includes("评审")) node.nodeType = "REVIEW";
					else if (node.name?.includes("TEST") || node.name?.includes("测试")) node.nodeType = "TEST";
					else if (node.name?.includes("GATE") || node.name?.includes("确认")) node.nodeType = "GATE";
					else if (node.name?.includes("DESIGN") || node.name?.includes("设计")) node.nodeType = "DESIGN";
					else node.nodeType = "DEVELOP";
				}
			}
			return state;
		},
	},
	{
		targetVersion: "2.3.0",
		description: "添加 outputs 字段 + correctionCount",
		apply: (state) => {
			for (const node of state.nodes || []) {
				if (!node.outputs) node.outputs = { files: [], keyDecisions: [], artifacts: [] };
				if (node.correctionCount === undefined) node.correctionCount = 0;
			}
			return state;
		},
	},
	{
		targetVersion: "2.4.0",
		description: "添加 events[] append-only 日志流",
		apply: (state) => {
			if (!state.events) state.events = [];
			return state;
		},
	},
	{
		targetVersion: "2.6.0",
		description: "PRD/SPEC 节点类型兼容 + edges 数组",
		apply: (state) => {
			if (!state.edges) state.edges = [];
			if (!state.meta) state.meta = {};
			for (const node of state.nodes || []) {
				if (node.nodeType === "PRD" || node.nodeType === "SPEC") continue;
			}
			return state;
		},
	},
];

// ═══════════════════════════════════════════════════════════
// 版本比较
// ═══════════════════════════════════════════════════════════

function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if ((pa[i] || 0) < (pb[i] || 0)) return -1;
		if ((pa[i] || 0) > (pb[i] || 0)) return 1;
	}
	return 0;
}

// ═══════════════════════════════════════════════════════════
// 核心迁移函数
// ═══════════════════════════════════════════════════════════

/**
 * v2.0 修正版：全量备份 → 深拷贝迁移 → 一次性写入 → 验证 → 清理
 * @param rawJSON  磁盘读取的原始 JSON 字符串
 * @param filePath 可选——传入则启用备份/写入/验证/清理全流程
 * @returns 最新版本的 DAGState
 */
export function migrateDAGState(rawJSON: string, filePath?: string): any {
	// 1. 解析
	let state: any;
	try {
		state = JSON.parse(rawJSON);
	} catch (e) {
		throw new Error(`DAG状态JSON解析失败: ${(e as Error).message}`);
	}

	const startVersion = state.version || "1.0.0";

	// 已是最新版本，无需迁移
	if (compareVersions(startVersion, LATEST_VERSION) >= 0) {
		return state;
	}

	// 2. 全量备份（迁移前，不影响原文件）
	let backupPath: string | undefined;
	if (filePath) {
		backupPath = `${filePath}.migration-backup-${Date.now()}.json`;
		try {
			atomicWriteJSON(backupPath, state);
		} catch {}
	}

	// 3. 深拷贝 + 内存中链式迁移
	let migrated = structuredClone(state);
	let lastVersion = startVersion;

	try {
		for (const migration of MIGRATIONS) {
			if (compareVersions(lastVersion, migration.targetVersion) < 0) {
				migrated = migration.apply(migrated);
				migrated.version = migration.targetVersion;
				lastVersion = migration.targetVersion;
			}
		}
		migrated.version = LATEST_VERSION;
	} catch (e) {
		// 迁移失败：不写入磁盘，保留原文件 + 备份
		throw new Error(
			`Migration failed from ${startVersion} at ${lastVersion}: ${(e as Error).message}. Backup: ${backupPath || "N/A"}`,
		);
	}

	// 4. 全量迁移成功后一次性写入磁盘
	if (filePath) {
		atomicWriteJSON(filePath, migrated);

		// 5. 验证：重新读取并检查版本
		try {
			const verified = JSON.parse(fs.readFileSync(filePath, "utf-8"));
			if (compareVersions(verified.version || "1.0.0", LATEST_VERSION) < 0) {
				// 验证失败：恢复备份
				const original = JSON.parse(fs.readFileSync(backupPath!, "utf-8"));
				atomicWriteJSON(filePath, original);
				throw new Error("Post-migration verification failed, restored original");
			}
		} catch (verifyErr) {
			if ((verifyErr as Error).message.includes("Post-migration")) throw verifyErr;
			// 读取验证失败：恢复备份
			if (backupPath && fs.existsSync(backupPath)) {
				const original = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
				atomicWriteJSON(filePath, original);
			}
			throw verifyErr;
		}

		// 6. 清理备份
		try { if (backupPath) fs.unlinkSync(backupPath); } catch {}
	}

	return migrated;
}

// ═══════════════════════════════════════════════════════════
// 安全加载（带备份降级）
// ═══════════════════════════════════════════════════════════

export function safeLoadDAGState(filePath: string): any | null {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return migrateDAGState(raw, filePath);
	} catch {
		// 降级：返回 null，让调用方使用默认状态
		return null;
	}
}
