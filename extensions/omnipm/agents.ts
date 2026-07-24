/**
 * OmniPM Agent Discovery — 专家子代理发现引擎
 * 
 * 从用户级 (~/.pi/agent/agents/) 和 OmniPM 内置专家库中发现可用 Agent。
 * OmniPM 内置 13 位专家，按需激活。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both" | "omnipm";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project" | "omnipm";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/**
 * D-1 预防：检测 agent .md 文件中 YAML frontmatter 的完整性。
 * \n 转义腐败同样可能影响 agent 定义文件的 frontmatter 解析。
 * 返回损坏的文件路径列表。
 */
function validateAgentFileIntegrity(filePath: string): string | null {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		// 检测 1: frontmatter 开闭合成对
		const dashes = [...raw.matchAll(/^---$/gm)];
		if (dashes.length < 2 || dashes.length % 2 !== 0) {
			return `YAML frontmatter 未闭合 (found ${dashes.length} --- markers)`;
		}
		// 检测 2: 正则字符串内字面换行（\.join\(" 后跟真实换行）
		if (/join\("\n/.test(raw)) {
			return "检测到 .join(\" + 字面换行 —— \\n 转义可能被展平";
		}
		return null;
	} catch {
		return "无法读取文件";
	}
}

function loadAgentsFromDir(dir: string, source: "user" | "project" | "omnipm"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);

		// D-1 预防：加载前校验文件完整性
		const integrityIssue = validateAgentFileIntegrity(filePath);
		if (integrityIssue) {
			console.error(`[OmniPM] ⚠️ Agent file integrity check failed: ${entry.name} — ${integrityIssue}`);
			continue; // 跳过损坏的 agent 定义
		}

		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model || undefined,
			systemPrompt: body.trim(),
			source,
			filePath,
		});
	}

	return agents;
}

/**
 * 获取 OmniPM 内置专家目录
 */
function getOmniPMAgentsDir(): string {
	// 优先级: 环境变量 > pi package 路径 > 相对于此文件的路径
	if (process.env.OMNIPM_AGENTS_DIR) return process.env.OMNIPM_AGENTS_DIR;
	
	// 尝试相对于当前文件的路径 (扩展安装位置)
	const relativePath = path.resolve(__dirname, "agents");
	if (fs.existsSync(relativePath)) return relativePath;
	
	// 尝试相对于 cwd 的路径
	const cwdPath = path.resolve(process.cwd(), "node_modules/@genesis/omnipm-orion/extensions/omnipm/agents");
	if (fs.existsSync(cwdPath)) return cwdPath;
	
	return relativePath; // fallback
}

export function discoverAgents(cwd: string, scope: AgentScope = "omnipm"): AgentDiscoveryResult {
	const agents: AgentConfig[] = [];
	let projectAgentsDir: string | null = null;

	// OmniPM 内置专家（默认始终加载）
	if (scope === "omnipm" || scope === "both") {
		const omnipmDir = getOmniPMAgentsDir();
		agents.push(...loadAgentsFromDir(omnipmDir, "omnipm"));
	}

	// 用户级 Agent
	if (scope === "user" || scope === "both") {
		const userDir = path.join(getAgentDir(), "agents");
		agents.push(...loadAgentsFromDir(userDir, "user"));
	}

	// 项目级 Agent
	if (scope === "project" || scope === "both") {
		const projectDir = path.join(cwd, CONFIG_NAME, "agents");
		if (fs.existsSync(projectDir)) {
			projectAgentsDir = projectDir;
			agents.push(...loadAgentsFromDir(projectDir, "project"));
		}
	}

	// 去重: OmniPM 内置 > 用户级 > 项目级 (同名以高优先级为准)
	const seen = new Map<string, AgentConfig>();
	const priority: Record<string, number> = { omnipm: 3, user: 2, project: 1 };
	
	for (const agent of agents) {
		const existing = seen.get(agent.name);
		if (!existing || priority[agent.source] > priority[existing.source]) {
			seen.set(agent.name, agent);
		}
	}

	return {
		agents: Array.from(seen.values()),
		projectAgentsDir,
	};
}
