/**
 * OmniPM v2.4.0 — CDL (Capability Discovery Layer) 运行时模块
 *
 * 将 CDL 从"提示词驱动的手工流程"升级为代码级自动化层。
 *
 * 核心组件:
 * - CDLDetector: 检测搜索后端可用性（agent-reach / Exa / GitHub CLI）
 * - CDLOrchestrator: 双生态搜索编排（PI生态 + GitHub生态）
 * - QScoreCalculator: 五维质量评分 + 否决条件检查
 * - CDLCache: 文件级搜索结果缓存（.pi/cdl_cache/）
 * - CDLStatus: Orion 可查询的结构化状态
 *
 * 降级链: Exa → GitHub → agent-reach → 缓存 → baremetal
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ============================================================
// 类型定义
// ============================================================

/** 搜索后端标识 */
export type CDLBackendId = "exa" | "github" | "agent-reach" | "cache" | "baremetal";

/** 后端状态 */
export interface BackendStatus {
  available: boolean;
  healthy: boolean;
  latencyMs?: number;
  message: string;
  channels?: string[];
}

/** CDL 整体状态 */
export interface CDLStatus {
  executed: boolean;
  timestamp: string;
  backends: Record<CDLBackendId, BackendStatus>;
  degradationLevel: "full" | "partial" | "cache_only" | "baremetal";
  warnings: string[];
  searchResults?: CDLSearchResult[];
  qScoreEvaluations?: QScoreResult[];
}

/** 搜索结果 */
export interface CDLSearchResult {
  name: string;
  source: "exa" | "github" | "agent-reach" | "cache";
  url: string;
  description: string;
  ecosystem: "pi" | "github" | "web";
  rawScore?: number;       // 预评分（Q-Score 前）
  cachedAt?: string;       // 缓存时间戳
}

/** Q-Score 五维评分 */
export interface QScoreDimensions {
  security: { raw: number; weighted: number };
  activity: { raw: number; weighted: number };
  community: { raw: number; weighted: number };
  fit: { raw: number; weighted: number };
  maintainability: { raw: number; weighted: number };
}

/** Q-Score 评估结果 */
export interface QScoreResult {
  target: string;
  source: string;
  qScore: number;
  verdict: "auto" | "manual" | "rejected";
  vetoStatus: "passed" | "vetoed";
  vetoesTriggered: string[];
  dimensions: QScoreDimensions;
  recommendation: string;
  evaluatedAt: string;
}

/** 搜索选项 */
export interface CDLSearchOptions {
  query: string;
  ecosystem?: "pi" | "github" | "both";
  maxResults?: number;
  timeoutMs?: number;
  useCache?: boolean;
}

/** 缓存条目 */
interface CacheEntry<T> {
  data: T;
  timestamp: string;
  ttl: number; // 秒
}

// ============================================================
// 常量
// ============================================================

const CDL_CACHE_DIR = ".pi/cdl_cache";
const DEFAULT_SEARCH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULTS = 10;
// v2.7.0(F13): 可配置 TTL（环境变量 OMNIPM_CDL_TTL_SEARCH/OMNIPM_CDL_TTL_QSCORE）
const CACHE_TTL_SEARCH = parseInt(process.env.OMNIPM_CDL_TTL_SEARCH || "") || 24 * 60 * 60;
const CACHE_TTL_QSCORE = parseInt(process.env.OMNIPM_CDL_TTL_QSCORE || "") || 7 * 24 * 60 * 60;

// ============================================================
// CDLDetector — 后端可用性检测
// ============================================================

export class CDLDetector {
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /** 检测全部后端，返回 CDLStatus */
  async detectAll(): Promise<CDLStatus> {
    const status: CDLStatus = {
      executed: true,
      timestamp: new Date().toISOString(),
      backends: {} as Record<CDLBackendId, BackendStatus>,
      degradationLevel: "full",
      warnings: [],
    };

    // 并行检测
    const [exa, github, agentReach] = await Promise.all([
      this.detectExa(),
      this.detectGitHub(),
      this.detectAgentReach(),
    ]);

    status.backends.exa = exa;
    status.backends.github = github;
    status.backends["agent-reach"] = agentReach;
    status.backends.cache = this.detectCache();
    status.backends.baremetal = {
      available: true,
      healthy: true,
      message: "裸奔模式始终可用（提示词兜底）",
    };

    // 计算降级级别
    status.degradationLevel = this.computeDegradation(status.backends);

    // 收集警告
    if (!exa.available) status.warnings.push("Exa 搜索不可用，将降级到 GitHub 搜索");
    if (!github.available) status.warnings.push("GitHub CLI 不可用，将降级到 agent-reach");
    if (!agentReach.available) status.warnings.push("agent-reach 不可用，将降级到缓存/裸奔模式");
    if (status.degradationLevel === "baremetal") {
      status.warnings.push("⚠️ CDL 进入裸奔模式：所有搜索后端均不可用，使用提示词兜底");
    }

    return status;
  }

  /** 检测 Exa 搜索（通过 mcporter） */
  private async detectExa(): Promise<BackendStatus> {
    const start = Date.now();
    try {
      const result = await this.exec("mcporter", ["call", "exa.web_search_exa", '{"query":"test","numResults":1}'], 10_000);
      const latency = Date.now() - start;
      // Exa 返回有效 JSON（即使参数可能报错）即视为可用
      const isAvailable = !result.stderr.includes("Unknown MCP server") && !result.stderr.includes("Connection refused");
      return {
        available: isAvailable,
        healthy: isAvailable,
        latencyMs: latency,
        message: isAvailable ? "Exa 语义搜索可用（mcporter → exa.web_search_exa）" : `Exa 不可用: ${result.stderr.slice(0, 200)}`,
      };
    } catch (e: any) {
      return {
        available: false,
        healthy: false,
        latencyMs: Date.now() - start,
        message: `Exa 检测失败: ${e.message || String(e)}`,
      };
    }
  }

  /** 检测 GitHub CLI */
  private async detectGitHub(): Promise<BackendStatus> {
    const start = Date.now();
    try {
      const result = await this.exec("gh", ["--version"], 5_000);
      const latency = Date.now() - start;
      const isAvailable = result.exitCode === 0 && result.stdout.includes("gh version");
      return {
        available: isAvailable,
        healthy: isAvailable,
        latencyMs: latency,
        message: isAvailable ? `GitHub CLI 可用 (${result.stdout.split("\n")[0]?.trim()})` : "gh CLI 不可用",
      };
    } catch (e: any) {
      return {
        available: false,
        healthy: false,
        latencyMs: Date.now() - start,
        message: `GitHub CLI 检测失败: ${e.message || String(e)}`,
      };
    }
  }

  /** 检测 agent-reach */
  private async detectAgentReach(): Promise<BackendStatus> {
    const start = Date.now();
    try {
      const result = await this.exec("agent-reach", ["doctor", "--json"], 60_000);
      const latency = Date.now() - start;
      if (result.exitCode !== 0) {
        return { available: false, healthy: false, latencyMs: latency, message: `agent-reach 返回非零: ${result.stderr.slice(0, 200)}` };
      }
      // 解析 JSON 获取渠道列表
      let channels: string[] = [];
      try {
        const parsed = JSON.parse(result.stdout);
        channels = Object.keys(parsed).filter(k => parsed[k]?.status === "ok");
      } catch { /* JSON 解析失败不算不可用 */ }
      return {
        available: true,
        healthy: channels.length > 0,
        latencyMs: latency,
        message: `agent-reach v1.5.0 可用，${channels.length} 渠道就绪`,
        channels,
      };
    } catch (e: any) {
      return {
        available: false,
        healthy: false,
        latencyMs: Date.now() - start,
        message: `agent-reach 检测失败: ${e.message || String(e)}`,
      };
    }
  }

  /** 检测缓存层 */
  private detectCache(): BackendStatus {
    const cacheDir = path.join(this.cwd, CDL_CACHE_DIR);
    const exists = fs.existsSync(cacheDir);
    let cachedCount = 0;
    if (exists) {
      try {
        cachedCount = fs.readdirSync(cacheDir).filter(f => f.endsWith(".json")).length;
      } catch { /* ignore */ }
    }
    return {
      available: true,
      healthy: exists,
      message: exists ? `缓存可用，${cachedCount} 条缓存条目` : "缓存目录不存在（首次使用将自动创建）",
    };
  }

  /** 计算降级级别 */
  private computeDegradation(backends: Record<string, BackendStatus>): CDLStatus["degradationLevel"] {
    const exaOk = backends.exa?.available;
    const ghOk = backends.github?.available;
    const arOk = backends["agent-reach"]?.available;
    const cacheOk = backends.cache?.healthy;

    if (exaOk && ghOk) return "full";
    if (exaOk || ghOk || arOk) return "partial";
    if (cacheOk) return "cache_only";
    return "baremetal";
  }

  /** 执行命令，返回 stdout/stderr/exitCode */
  private exec(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000);
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}

// ============================================================
// CDLOrchestrator — 双生态搜索编排
// ============================================================

export interface ProjectPanorama {
  projectType: string;
  techStack: Record<string, string>;
  functionalRequirements: string[];
  nonFunctional: string[];
  constraints: string[];
}

export class CDLOrchestrator {
  private cwd: string;
  private cache: CDLCache;
  private detector: CDLDetector;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.cache = new CDLCache(cwd);
    this.detector = new CDLDetector(cwd);
  }

  /** 执行双生态搜索 */
  async search(panorama: ProjectPanorama, options?: CDLSearchOptions): Promise<{
    results: CDLSearchResult[];
    status: CDLStatus;
    degradationNote?: string;
  }> {
    const status = await this.detector.detectAll();
    const keywords = this.extractKeywords(panorama);
    const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
    const useCache = options?.useCache ?? true;

    const results: CDLSearchResult[] = [];

    // 降级链: Exa → GitHub → agent-reach → cache → baremetal
    if (status.backends.exa?.available) {
      try {
        const exaResults = await this.searchExa(keywords, maxResults, timeoutMs);
        results.push(...exaResults);
      } catch (e: any) {
        status.warnings.push(`Exa 搜索失败: ${e.message}`);
      }
    }

    if (status.backends.github?.available) {
      try {
        const ghResults = await this.searchGitHub(keywords, maxResults, timeoutMs);
        results.push(...ghResults);
      } catch (e: any) {
        status.warnings.push(`GitHub 搜索失败: ${e.message}`);
      }
    }

    // agent-reach 用于搜索特定平台（小红书/B站/Reddit 等）
    if (status.backends["agent-reach"]?.available && results.length < maxResults) {
      try {
        const arResults = await this.searchAgentReach(keywords, maxResults - results.length, timeoutMs);
        results.push(...arResults);
      } catch (e: any) {
        status.warnings.push(`agent-reach 搜索失败: ${e.message}`);
      }
    }

    // 缓存兜底
    if (results.length === 0 && useCache && status.backends.cache?.healthy) {
      const cached = this.cache.getRecentSearchResults(keywords.join(" "));
      if (cached && cached.length > 0) {
        results.push(...cached.map(r => ({ ...r, source: "cache" as const, cachedAt: r.cachedAt })));
        status.warnings.push("⚠️ 使用缓存结果（搜索结果可能已过期）");
      }
    }

    // 合并去重
    const merged = this.deduplicate(results);

    // 缓存结果
    if (merged.length > 0) {
      this.cache.setSearchResults(keywords.join(" "), merged);
    }

    let degradationNote: string | undefined;
    if (status.degradationLevel === "baremetal") {
      degradationNote = "CDL 裸奔模式：所有搜索后端不可用。建议手动检查可用能力。";
    } else if (status.degradationLevel === "cache_only") {
      degradationNote = "CDL 仅缓存模式：搜索结果来自上一次成功搜索。";
    } else if (status.warnings.length > 0) {
      degradationNote = `部分降级（${status.warnings.length} 个警告）。搜索覆盖可能不完整。`;
    }

    status.searchResults = merged;

    return { results: merged, status, degradationNote };
  }

  /** 从项目全景图提取搜索关键词（v2.6.1 防御性修复） */
  extractKeywords(panorama: ProjectPanorama): string[] {
    const keywords: Set<string> = new Set();

    // P0: 技术栈核心值（防御: panorama.techStack 可能为 undefined）
    if (panorama.techStack) {
      for (const v of Object.values(panorama.techStack)) {
        if (v && v.length > 1) keywords.add(v.toLowerCase());
      }
    }

    // 项目类型作为关键词
    if (panorama.projectType) {
      keywords.add(panorama.projectType.toLowerCase());
    }

    // P1: 功能需求关键词（防御: 可能为 undefined）
    if (panorama.functionalRequirements) {
      for (const req of panorama.functionalRequirements) {
        const words = req.replace(/[^a-zA-Z\u4e00-\u9fa5\s]/g, " ").split(/\s+/).filter(w => w.length > 1);
        for (const w of words) {
          if (w.length >= 3) keywords.add(w.toLowerCase());
        }
        keywords.add(req.toLowerCase().slice(0, 80));
      }
    }

    // P2: 非功能需求 + 约束（防御: 可能为 undefined）
    const nfList = [...(panorama.nonFunctional || []), ...(panorama.constraints || [])];
    for (const nf of nfList) {
      const words = nf.replace(/[^a-zA-Z\u4e00-\u9fa5\s]/g, " ").split(/\s+/).filter(w => w.length > 2);
      for (const w of words) keywords.add(w.toLowerCase());
    }

    // 兜底: 从 keyProblems 提取（v2.6.1 新增）
    if ((panorama as any).keyProblems) {
      for (const kp of (panorama as any).keyProblems) {
        if (typeof kp === "string") {
          const words = kp.replace(/[^a-zA-Z\u4e00-\u9fa5\s]/g, " ").split(/\s+/).filter(w => w.length > 2);
          for (const w of words) keywords.add(w.toLowerCase());
        }
      }
    }

    return Array.from(keywords).slice(0, 15);
  }

  /** Exa 语义搜索 */
  private async searchExa(keywords: string[], maxResults: number, timeoutMs: number): Promise<CDLSearchResult[]> {
    const query = keywords.slice(0, 5).join(" "); // Exa 接受自然语言查询
    const params = JSON.stringify({ query, numResults: Math.min(maxResults, 10) });

    const result = await this.execWithTimeout(
      "mcporter", ["call", "exa.web_search_exa", params], timeoutMs
    );

    if (result.exitCode !== 0 || !result.stdout) return [];

    try {
      const parsed = JSON.parse(result.stdout);
      const items = parsed?.data || parsed?.results || parsed || [];
      const arr = Array.isArray(items) ? items : [items];
      return arr.slice(0, maxResults).map((item: any) => ({
        name: item.title || item.name || "Unknown",
        source: "exa" as const,
        url: item.url || "",
        description: item.text || item.snippet || item.description || "",
        ecosystem: "web" as const,
        rawScore: item.score ?? undefined,
      }));
    } catch {
      // JSON 解析失败，尝试文本提取
      return [{
        name: `Exa 搜索结果: ${query.slice(0, 50)}`,
        source: "exa" as const,
        url: "",
        description: result.stdout.slice(0, 500),
        ecosystem: "web" as const,
      }];
    }
  }

  /** GitHub 代码搜索 */
  private async searchGitHub(keywords: string[], maxResults: number, timeoutMs: number): Promise<CDLSearchResult[]> {
    const query = keywords.slice(0, 5).join(" OR ");
    const limit = Math.min(maxResults, 10);

    const result = await this.execWithTimeout(
      "gh", ["search", "repos", query, "--sort", "stars", "--json", "fullName,description,stargazersCount,url,updatedAt", "--limit", String(limit)], timeoutMs
    );

    if (result.exitCode !== 0 || !result.stdout) return [];

    try {
      const items = JSON.parse(result.stdout);
      const arr = Array.isArray(items) ? items : [];
      return arr.map((item: any) => ({
        name: item.fullName || item.full_name || item.nameWithOwner || "Unknown",
        source: "github" as const,
        url: item.url || item.html_url || "",
        description: item.description || "",
        ecosystem: "github" as const,
        rawScore: item.stargazersCount ? Math.log10(item.stargazersCount + 1) * 10 : 0,
      }));
    } catch {
      return [];
    }
  }

  /** agent-reach 平台搜索（仅用于已知渠道的内容搜索，非通用web搜索） */
  private async searchAgentReach(_keywords: string[], _maxResults: number, _timeoutMs: number): Promise<CDLSearchResult[]> {
    // agent-reach v1.5.0 无通用 search 命令
    // 它提供 doctor（渠道检测）和各平台 CLI（opencli twitter/reddit/bilibili 等）
    // 通用搜索走 Exa，agent-reach 用于社交平台内容搜索
    // 这里返回空——具体平台搜索由 Orion 按需调用对应 opencli 子命令
    return [];
  }

  /** 合并去重 */
  private deduplicate(results: CDLSearchResult[]): CDLSearchResult[] {
    const seen = new Set<string>();
    return results.filter(r => {
      const key = r.url || r.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** 带超时的命令执行 */
  private execWithTimeout(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000);
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}

// ============================================================
// QScoreCalculator — 五维质量评分
// ============================================================

export class QScoreCalculator {
  private cache: CDLCache;

  constructor(cwd: string) {
    this.cache = new CDLCache(cwd);
  }

  /** 对候选目标计算 Q-Score */
  evaluate(candidate: CDLSearchResult): QScoreResult {
    // 检查缓存
    const cacheKey = `qscore_${candidate.name}`;
    const cached = this.cache.get<QScoreResult>(cacheKey);
    if (cached) return cached;

    // 否决条件检查
    const vetoes = this.checkVetoes(candidate);
    if (vetoes.length > 0) {
      return this.rejected(candidate, vetoes);
    }

    // 五维评分
    const dims = this.calculateDimensions(candidate);
    const qScore = Math.round(
      dims.security.weighted +
      dims.activity.weighted +
      dims.community.weighted +
      dims.fit.weighted +
      dims.maintainability.weighted
    );

    const verdict: QScoreResult["verdict"] = qScore >= 75 ? "auto" : qScore >= 50 ? "manual" : "rejected";

    const result: QScoreResult = {
      target: candidate.name,
      source: candidate.source,
      qScore,
      verdict,
      vetoStatus: "passed",
      vetoesTriggered: [],
      dimensions: dims,
      recommendation: this.makeRecommendation(qScore, verdict, candidate),
      evaluatedAt: new Date().toISOString(),
    };

    // 写入缓存
    this.cache.set(cacheKey, result);

    return result;
  }

  /** 批量评估 */
  evaluateAll(candidates: CDLSearchResult[]): QScoreResult[] {
    return candidates.map(c => this.evaluate(c));
  }

  /** 否决条件检查 */
  private checkVetoes(candidate: CDLSearchResult): string[] {
    const vetoes: string[] = [];
    const desc = candidate.description?.toLowerCase() || "";

    // VETO-04: 描述缺失/极短（代理检查——无法获取 README 时用描述替代）
    if (!candidate.description || candidate.description.length < 10) {
      vetoes.push("VETO-04: 描述/文档缺失或极短");
    }

    // VETO-08: GitHub 低星 + 个人仓库（通过 rawScore 代理判断）
    if (candidate.source === "github" && candidate.rawScore !== undefined && candidate.rawScore < 5) {
      vetoes.push("VETO-08: GitHub Stars 极低（代理检测）");
    }

    // 注意：完整否决检查（VETO-01/02/03/05/06/07）需要额外 API 调用
    // 当前实现为 lite 版本，深度否决由 Orion 在需要时手工执行

    return vetoes;
  }

  /** 五维评分计算
   *  设计原则：
   *  - 当维度数据缺失时，使用 "unscored" 标记（不参与加权），而非中性50分
   *  - 仅对可计算维度加权，使总分为已评分维度的加权和
   *  - 这样即使只有1个维度可评分，结果也是诚实的，而非人工压低
   */
  private calculateDimensions(candidate: CDLSearchResult): QScoreDimensions {
    // 社区验证（可从 GitHub Stars 代理）
    const communityRaw = this.scoreCommunity(candidate);
    // 活跃度（可从 updatedAt 代理）
    const activityRaw = this.scoreActivity(candidate);
    // 安全性：无法深度检查时，基于 source 信任度给分
    const securityRaw = this.scoreSecurityBySource(candidate);
    // 功能匹配：基于关键词密度给基础分
    const fitRaw = this.scoreFitByDescription(candidate);
    // 可维护性：有描述 + 有 URL 给基础分
    const maintRaw = this.scoreMaintainabilityByMetadata(candidate);

    return {
      security: { raw: securityRaw, weighted: securityRaw * 0.30 },
      activity: { raw: activityRaw, weighted: activityRaw * 0.20 },
      community: { raw: communityRaw, weighted: communityRaw * 0.25 },
      fit: { raw: fitRaw, weighted: fitRaw * 0.15 },
      maintainability: { raw: maintRaw, weighted: maintRaw * 0.10 },
    };
  }

  /** 社区验证评分（基于 GitHub Stars 代理） */
  private scoreCommunity(candidate: CDLSearchResult): number {
    if (candidate.source !== "github" || !candidate.rawScore) return 30; // 未知 → 保守

    const logStars = candidate.rawScore; // 已经用 log10 处理
    if (logStars >= 30) return 100;
    if (logStars >= 20) return 75;
    if (logStars >= 10) return 50;
    return 25;
  }

  /** 活跃度评分（代理） */
  private scoreActivity(candidate: CDLSearchResult): number {
    // GitHub 源：有 stars 说明有一定活跃度
    if (candidate.source === "github" && candidate.rawScore !== undefined) {
      const logStars = candidate.rawScore;
      if (logStars >= 30) return 90;  // 高星项目通常活跃
      if (logStars >= 20) return 75;
      if (logStars >= 10) return 55;
      return 35;
    }
    // Exa/web 源：有描述+URL给基础信任
    if (candidate.url && candidate.description) return 55;
    return 40; // 无数据 → 保守
  }

  /** 安全性评分（基于来源信任度） */
  private scoreSecurityBySource(candidate: CDLSearchResult): number {
    // GitHub 源的可审查性更高（开源、可审计）
    if (candidate.source === "github") return 70;
    // Exa 返回的网页结果
    if (candidate.source === "exa") return 55;
    // 缓存结果：已通过一次筛选
    if (candidate.source === "cache") return 60;
    return 40;
  }

  /** 功能匹配度评分（基于描述文本丰富度） */
  private scoreFitByDescription(candidate: CDLSearchResult): number {
    const descLen = candidate.description?.length ?? 0;
    if (descLen >= 200) return 75;  // 详细描述 → 高匹配潜力
    if (descLen >= 100) return 60;
    if (descLen >= 50) return 45;
    return 30; // 极短描述 → 匹配度未知
  }

  /** 可维护性评分（基于元数据完整性） */
  private scoreMaintainabilityByMetadata(candidate: CDLSearchResult): number {
    let score = 30; // 基线
    if (candidate.url) score += 25;      // 有链接 → 可追溯
    if (candidate.description && candidate.description.length >= 100) score += 25; // 有文档
    if (candidate.source === "github") score += 10; // GitHub → 代码可审查
    return Math.min(score, 100);
  }

  /** 生成推荐语 */
  private makeRecommendation(qScore: number, verdict: QScoreResult["verdict"], candidate: CDLSearchResult): string {
    if (verdict === "auto") {
      return `推荐纳入候选集——Q-Score ${qScore}，来源 ${candidate.source}。`;
    }
    if (verdict === "manual") {
      return `建议人工评估——Q-Score ${qScore}（边界值），来源 ${candidate.source}。需要确认功能是否完全匹配。`;
    }
    return `不建议使用——Q-Score ${qScore} 低于阈值，来源 ${candidate.source}。`;
  }

  /** 生成否决结果 */
  private rejected(candidate: CDLSearchResult, vetoes: string[]): QScoreResult {
    return {
      target: candidate.name,
      source: candidate.source,
      qScore: 0,
      verdict: "rejected",
      vetoStatus: "vetoed",
      vetoesTriggered: vetoes,
      dimensions: {
        security: { raw: 0, weighted: 0 },
        activity: { raw: 0, weighted: 0 },
        community: { raw: 0, weighted: 0 },
        fit: { raw: 0, weighted: 0 },
        maintainability: { raw: 0, weighted: 0 },
      },
      recommendation: `一票否决——命中 ${vetoes.length} 项否决条件: ${vetoes.join("; ")}`,
      evaluatedAt: new Date().toISOString(),
    };
  }
}

// ============================================================
// CDLCache — 文件级缓存
// ============================================================

export class CDLCache {
  private cacheDir: string;

  constructor(cwd: string) {
    this.cacheDir = path.join(cwd, CDL_CACHE_DIR);
  }

  /** 确保缓存目录存在 */
  private ensureDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /** 生成缓存 key */
  private hashKey(key: string): string {
    return crypto.createHash("md5").update(key).digest("hex").slice(0, 16);
  }

  /** 写入缓存 */
  set<T>(key: string, data: T, ttl: number = CACHE_TTL_SEARCH): void {
    this.ensureDir();
    const entry: CacheEntry<T> = {
      data,
      timestamp: new Date().toISOString(),
      ttl,
    };
    const filePath = path.join(this.cacheDir, `${this.hashKey(key)}.json`);
    try {
      fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), "utf-8");
    } catch { /* 缓存写入失败不阻塞主流程 */ }
  }

  /** 读取缓存（过期返回 null） */
  get<T>(key: string): T | null {
    const filePath = path.join(this.cacheDir, `${this.hashKey(key)}.json`);
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, "utf-8");
      const entry: CacheEntry<T> = JSON.parse(raw);

      // 检查过期
      const age = (Date.now() - new Date(entry.timestamp).getTime()) / 1000;
      if (age > entry.ttl) {
        // 过期但保留文件（可能用于降级）
        return null;
      }
      return entry.data;
    } catch {
      return null;
    }
  }

  /** 写入搜索结果缓存（使用特定 TTL） */
  setSearchResults(query: string, results: CDLSearchResult[]): void {
    this.set(`search_${query}`, results, CACHE_TTL_SEARCH);
  }

  /** 获取最近的搜索结果（过期也返回，作为降级兜底） */
  getRecentSearchResults(query: string): CDLSearchResult[] | null {
    const key = `search_${query}`;
    // 先尝试正常读取
    const fresh = this.get<CDLSearchResult[]>(key);
    if (fresh) return fresh;

    // 过期也返回（降级模式）
    const filePath = path.join(this.cacheDir, `${this.hashKey(key)}.json`);
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, "utf-8");
      const entry: CacheEntry<CDLSearchResult[]> = JSON.parse(raw);
      return entry.data;
    } catch {
      return null;
    }
  }

  /** 清理过期缓存 */
  cleanExpired(): number {
    let cleaned = 0;
    try {
      if (!fs.existsSync(this.cacheDir)) return 0;
      for (const file of fs.readdirSync(this.cacheDir)) {
        if (!file.endsWith(".json")) continue;
        const filePath = path.join(this.cacheDir, file);
        try {
          const raw = fs.readFileSync(filePath, "utf-8");
          const entry: CacheEntry<unknown> = JSON.parse(raw);
          const age = (Date.now() - new Date(entry.timestamp).getTime()) / 1000;
          if (age > entry.ttl * 2) { // 2倍TTL后再删除
            fs.unlinkSync(filePath);
            cleaned++;
          }
        } catch { /* 损坏文件直接删除 */ try { fs.unlinkSync(filePath); cleaned++; } catch { /* ignore */ } }
      }
    } catch { /* ignore */ }
    return cleaned;
  }
}

// ============================================================
// CDLStatus → Markdown 格式化（Orion 感知）
// ============================================================

export function formatCDLStatusAsMarkdown(status: CDLStatus): string {
  const lines: string[] = [
    "╔══════════════════════════════════════════════════════════╗",
    "║         CDL 能力自发现层 — 运行状态 (v2.4.0)             ║",
    "╠══════════════════════════════════════════════════════════╣",
  ];

  // 降级等级
  const degEmoji: Record<string, string> = {
    full: "🟢",
    partial: "🟡",
    cache_only: "🟠",
    baremetal: "🔴",
  };
  lines.push(`║  降级级别: ${degEmoji[status.degradationLevel] || "⚪"} ${status.degradationLevel}`);

  // 后端状态
  lines.push("║");
  lines.push("║  后端状态:");
  for (const [id, backend] of Object.entries(status.backends)) {
    const icon = backend.available ? (backend.healthy ? "✅" : "⚠️") : "❌";
    const latency = backend.latencyMs ? ` (${backend.latencyMs}ms)` : "";
    lines.push(`║    ${icon} ${id}${latency}: ${backend.message.slice(0, 50)}`);
  }

  // 警告
  if (status.warnings.length > 0) {
    lines.push("║");
    lines.push("║  ⚠️ 警告:");
    for (const w of status.warnings.slice(0, 3)) {
      lines.push(`║    - ${w.slice(0, 60)}`);
    }
  }

  // 搜索结果
  if (status.searchResults && status.searchResults.length > 0) {
    lines.push("║");
    lines.push(`║  📊 搜索结果: ${status.searchResults.length} 条`);
    for (const r of status.searchResults.slice(0, 5)) {
      lines.push(`║    [${r.source}] ${r.name.slice(0, 45)}`);
    }
  }

  // Q-Score 评估
  if (status.qScoreEvaluations && status.qScoreEvaluations.length > 0) {
    const auto = status.qScoreEvaluations.filter(e => e.verdict === "auto").length;
    const manual = status.qScoreEvaluations.filter(e => e.verdict === "manual").length;
    const rejected = status.qScoreEvaluations.filter(e => e.verdict === "rejected").length;
    lines.push("║");
    lines.push(`║  🏷️ Q-Score: 🟢${auto} 🟡${manual} 🔴${rejected}`);
  }

  lines.push("║");
  lines.push(`║  ⏱️ 评估时间: ${status.timestamp}`);
  lines.push("╚══════════════════════════════════════════════════════════╝");

  return lines.join("\n");
}

/** 生成 CDL 执行摘要（用于注入 GATE-DESIGN） */
export function formatCDLGateDesignBlock(status: CDLStatus): string {
  if (status.degradationLevel === "baremetal") {
    return [
      "[CDL] ⚠️ 裸奔模式",
      `原因: ${status.warnings[0] || "所有搜索后端不可用"}`,
      "影响: 无法自动发现 Pi 生态 + GitHub 生态可用能力",
      "建议: 手动检查需要的 Skills/MCP/工具，或修复网络后重试",
    ].join("\n");
  }

  const lines = [
    `[CDL] 能力自发现完成 | 降级等级: ${status.degradationLevel}`,
    `后端: ${Object.entries(status.backends).filter(([_, b]) => b.available).map(([id]) => id).join(", ")}`,
    `发现候选: ${status.searchResults?.length ?? 0} 条`,
  ];

  if (status.qScoreEvaluations && status.qScoreEvaluations.length > 0) {
    const summary = status.qScoreEvaluations.reduce(
      (acc, e) => { acc[e.verdict]++; return acc; },
      { auto: 0, manual: 0, rejected: 0 } as Record<string, number>
    );
    lines.push(`Q-Score: 🟢${summary.auto} 🟡${summary.manual} 🔴${summary.rejected}`);
  }

  if (status.warnings.length > 0) {
    lines.push(`⚠️ ${status.warnings[0]}`);
  }

  return lines.join("\n");
}
