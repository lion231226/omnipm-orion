/**
 * OmniPM v2.2.0 — Pi Adapter
 * 
 * 将现有 Pi Extension API 适配到 ARI (Abstract Runtime Interface)。
 * 这是"重构而非重写"——现有代码不变，新增适配层。
 */

import type {
  IEventBus,
  IFileSystem,
  ISubagentRuntime,
  IStorage,
  IUserInterface,
  PlatformCapabilities,
} from "./interface.ts";

/**
 * Pi 平台能力声明
 */
export const PI_CAPABILITIES: PlatformCapabilities = {
  platform: "pi",
  subagentMode: "native_process",
  maxConcurrency: 4,
  processIsolation: true,
  hasEventBus: true,
  dagPersistence: "tool_state",
  contextWindow: 200000,
  toolCallMechanism: "native",
};

/**
 * PiFileSystem — 基于 Node.js fs 模块的 IFileSystem 实现
 */
export class PiFileSystem implements IFileSystem {
  constructor(public cwd: string) {}

  async read(path: string, encoding?: BufferEncoding): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    return readFile(path, encoding ?? "utf-8");
  }

  async readBinary(path: string): Promise<Buffer> {
    const { readFile } = await import("node:fs/promises");
    return readFile(path);
  }

  async write(path: string, content: string): Promise<void> {
    const { writeFile } = await import("node:fs/promises");
    const { mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf-8");
  }

  async exists(path: string): Promise<boolean> {
    const { access } = await import("node:fs/promises");
    try { await access(path); return true; } catch { return false; }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path, options);
  }

  async unlink(path: string): Promise<void> {
    const { unlink } = await import("node:fs/promises");
    await unlink(path);
  }

  async glob(_pattern: string): Promise<string[]> {
    // 简化实现
    return [];
  }

  async atomicWrite(path: string, content: string): Promise<void> {
    const { writeFile, rename } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const { randomUUID } = await import("node:crypto");
    const tmpPath = path + "." + randomUUID() + ".tmp";
    await this.mkdir(dirname(path), { recursive: true });
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, path);
  }
}

/**
 * PiEventBus — 基于 Pi Extension events 的 IEventBus 实现
 */
export class PiEventBus implements IEventBus {
  constructor(private piEvents?: { on: Function; emit: Function }) {}

  on(eventType: string, handler: Function): void {
    this.piEvents?.on(eventType, handler);
  }

  off(eventType: string, handler: Function): void {
    // Pi events 无原生 off，记录忽略
  }

  emit(eventType: string, payload: Record<string, unknown>): void {
    this.piEvents?.emit(eventType, payload);
  }
}

/**
 * PiStorage — 基于 DAG JSON 文件的 IStorage 实现
 */
export class PiStorage implements IStorage {
  constructor(private cwd: string, private fs: IFileSystem) {}

  async get<T>(key: string): Promise<T | null> {
    const p = `${this.cwd}/.pi/${key}.json`;
    if (!(await this.fs.exists(p))) return null;
    try { return JSON.parse(await this.fs.read(p)) as T; } catch { return null; }
  }

  async set<T>(key: string, value: T): Promise<void> {
    const p = `${this.cwd}/.pi/${key}.json`;
    await this.fs.atomicWrite(p, JSON.stringify(value, null, 2));
  }

  async delete(key: string): Promise<void> {
    const p = `${this.cwd}/.pi/${key}.json`;
    if (await this.fs.exists(p)) await this.fs.unlink(p);
  }

  async loadDAGState(_projectName: string): Promise<any> {
    return this.get("omnipm_dag_state");
  }

  async saveDAGState(_projectName: string, state: any): Promise<void> {
    await this.set("omnipm_dag_state", state);
  }
}
