// feedback#1022 回归：model-io 调试日志磁盘占用无界。
// 覆盖三层：①开发态 debug 目录按文件数轮转（此前被 !development 门控跳过）；
// ②全量保留模式仍按文件数轮转（单文件更大且不压缩，文件个数必须有界）；
// ③启动兜底 cleanup 按 mtime 删除 7 天前的 session 文件。
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupModelIoRetention,
  MODEL_IO_CLEANUP_STARTUP_DELAY_MS,
  scheduleModelIoRetentionCleanup,
} from "../src/model/runner-debug-retention.js";
import { recordStreamTextDebug } from "../src/model/runner-debug.js";
import type {
  AiSdkModelTextRequest,
  AiSdkStreamTextOptions,
  AiSdkStreamTextResult,
  ResolvedAiSdkModel,
} from "../src/model/runner-runtime.js";

const MAX_DEBUG_FILES = 10; // 对齐 runner-debug.ts 的 MAX_DEBUG_FILES
const MAX_ROLLOUT_FILES = 3; // 对齐 runner-debug.ts 的 MAX_ROLLOUT_FILES

const resolved = {
  providerId: "test-provider",
  modelId: "test-model",
  baseURL: "https://api.example.test",
  headers: {},
  providerKind: "anthropic",
} as unknown as ResolvedAiSdkModel;

// 测试态不该依赖 shouldRecordModelIO（test 态不写盘），所以显式传 recordModelIO: true，
// 并用 debugDir 注入目录、isDev 注入目录语义——与 runner-debug-media-redaction.test.ts 同模式。
async function writeSessionRecord(input: {
  debugDir: string;
  fullRetention?: boolean;
  isDev: boolean;
  sessionId: string;
}): Promise<void> {
  await recordStreamTextDebug({
    attempt: 1,
    debugDir: input.debugDir,
    isDev: input.isDev,
    modelIoFullRetentionEnabled: input.fullRetention ?? false,
    normalizedToolCalls: [],
    options: { messages: [] } as unknown as AiSdkStreamTextOptions,
    recordModelIO: true,
    request: {
      messages: [{ role: "user", content: "hi" }],
      metadata: { sessionId: input.sessionId },
    } as unknown as AiSdkModelTextRequest,
    resolved,
    result: {
      response: Promise.resolve({ text: "ok" }),
    } as unknown as AiSdkStreamTextResult,
    startedAt: Date.now(),
  });
}

// 预置轮转候选文件并显式拉开 mtime，避免同毫秒创建导致「删最旧」顺序不确定。
async function seedSessionFiles(dir: string, sessionIds: string[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (let index = 0; index < sessionIds.length; index += 1) {
    const filePath = join(dir, `model-io-${sessionIds[index]}.jsonl`);
    await writeFile(filePath, "{}\n", "utf8");
    const mtimeMs = Date.now() - (sessionIds.length - index) * 60_000;
    await utimes(filePath, new Date(mtimeMs), new Date(mtimeMs));
  }
}

describe("model-io runner debug retention", () => {
  let debugDir: string;

  beforeEach(async () => {
    debugDir = await mkdtempDir();
  });

  afterEach(async () => {
    await rm(debugDir, { recursive: true, force: true });
  });

  it("开发态 debug 目录新建 session 时触发文件数轮转并保留 MAX_DEBUG_FILES 个", async () => {
    await seedSessionFiles(debugDir, ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10"]);

    await writeSessionRecord({ debugDir, isDev: true, sessionId: "s11" });

    expect(await listSessionFiles(debugDir)).toHaveLength(MAX_DEBUG_FILES);
    expect(existsSync(join(debugDir, "model-io-s1.jsonl"))).toBe(false);
    for (const session of ["s2", "s10", "s11"]) {
      expect(existsSync(join(debugDir, `model-io-${session}.jsonl`))).toBe(true);
    }
  });

  it("生产态 rollout 目录维持 MAX_ROLLOUT_FILES 个的既有上限", async () => {
    await seedSessionFiles(debugDir, ["r1", "r2", "r3"]);

    await writeSessionRecord({ debugDir, isDev: false, sessionId: "r4" });

    expect(await listSessionFiles(debugDir)).toHaveLength(MAX_ROLLOUT_FILES);
    expect(existsSync(join(debugDir, "model-io-r1.jsonl"))).toBe(false);
    expect(existsSync(join(debugDir, "model-io-r4.jsonl"))).toBe(true);
  });

  it("同 session 追加写入不触发轮转（只在新 session 出现时淘汰）", async () => {
    await seedSessionFiles(debugDir, ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10"]);

    await writeSessionRecord({ debugDir, isDev: true, sessionId: "s1" });

    expect(await listSessionFiles(debugDir)).toHaveLength(MAX_DEBUG_FILES);
    expect(existsSync(join(debugDir, "model-io-s1.jsonl"))).toBe(true);
  });

  it("全量保留模式下轮转仍生效，新记录仍为完整未压缩内容", async () => {
    await seedSessionFiles(debugDir, ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10"]);

    await writeSessionRecord({
      debugDir,
      fullRetention: true,
      isDev: true,
      sessionId: "s11",
    });

    // 全量模式只放宽单文件容量与压缩，不放宽文件个数（feedback#1022：否则关闭开关后遗留文件无清理路径）。
    expect(await listSessionFiles(debugDir)).toHaveLength(MAX_DEBUG_FILES);
    expect(existsSync(join(debugDir, "model-io-s1.jsonl"))).toBe(false);

    const newRecord = JSON.parse(
      await readFile(join(debugDir, "model-io-s11.jsonl"), "utf8"),
    ) as { messagesKind?: string; request?: { messages?: unknown[] } };
    expect(Array.isArray(newRecord.request?.messages)).toBe(true);
    // 全量模式跳过 delta/tail 压缩：不应出现压缩标注，也不应有单文件容量重置标记。
    expect(newRecord.messagesKind).toBeUndefined();
    expect(JSON.stringify(newRecord)).not.toContain("modelIOReset");
  });

  it("cleanupModelIoRetention 删除超过保留期的 session 文件并保留其余文件", async () => {
    const now = new Date("2026-10-13T12:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    const seed = async (name: string, mtimeMs: number): Promise<void> => {
      const filePath = join(debugDir, name);
      await writeFile(filePath, "{}\n", "utf8");
      await utimes(filePath, new Date(mtimeMs), new Date(mtimeMs));
    };
    await seed("model-io-old.jsonl", now.getTime() - 8 * day);
    await seed("model-io-recent.jsonl", now.getTime() - 1 * day);
    await seed("model-io-boundary.jsonl", now.getTime() - 7 * day);
    await seed("notes.jsonl", now.getTime() - 30 * day);
    await seed("model-io-old.txt", now.getTime() - 30 * day);

    const result = await cleanupModelIoRetention({
      now,
      rootDirs: [debugDir, join(debugDir, "not-created")],
    });

    // 目录不存在视为已清理，不算失败；只有匹配 model-io-*.jsonl 且 mtime 早于 cutoff 的文件被删。
    expect(result.status).toBe("completed");
    expect(result.retentionDays).toBe(7);
    expect(result.scannedFiles).toBe(3);
    expect(result.deletedFiles).toEqual(["model-io-old.jsonl"]);
    expect(result.failedFiles).toEqual([]);
    expect(existsSync(join(debugDir, "model-io-old.jsonl"))).toBe(false);
    for (const name of [
      "model-io-recent.jsonl",
      "model-io-boundary.jsonl",
      "notes.jsonl",
      "model-io-old.txt",
    ]) {
      expect(existsSync(join(debugDir, name))).toBe(true);
    }
  });

  it("scheduleModelIoRetentionCleanup 使用启动延迟并 unref 定时器，触发时按注入的 now 清理", async () => {
    const now = new Date("2026-10-13T12:00:00Z");
    const oldPath = join(debugDir, "model-io-ancient.jsonl");
    await writeFile(oldPath, "{}\n", "utf8");
    await utimes(oldPath, new Date(0), new Date(0));

    const timers: Array<{ callback: () => void; delayMs: number }> = [];
    const timer = { unrefCalls: 0, unref() { this.unrefCalls += 1; } };
    const handle = scheduleModelIoRetentionCleanup({
      now: () => now,
      rootDirs: [debugDir],
      setTimeout: (callback, delayMs) => {
        timers.push({ callback, delayMs });
        return timer;
      },
    });

    expect(timers).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(MODEL_IO_CLEANUP_STARTUP_DELAY_MS);
    expect(timer.unrefCalls).toBe(1);
    expect(handle).toBe(timer);
    expect(existsSync(oldPath)).toBe(true);

    timers[0]?.callback();
    await vi.waitFor(() => {
      expect(existsSync(oldPath)).toBe(false);
    });
  });
});

async function mkdtempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "zcode-model-io-retention-"));
}

async function listSessionFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((name) => name.startsWith("model-io-") && name.endsWith(".jsonl")).sort();
}
