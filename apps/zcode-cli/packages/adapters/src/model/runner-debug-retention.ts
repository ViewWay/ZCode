import type { Dirent } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@zcode/contracts";

// model-io 诊断日志的启动兜底清理（feedback#1022）：
// 写入侧的文件数轮转只覆盖进程内写入路径，用户关闭全量保留开关后遗留的巨型 session 文件
// 没有任何清理路径。这里按 mtime 删除超过保留期的 model-io-*.jsonl，
// 保留期与启动延迟对齐 logging/retention.ts 的默认（7 天 / 60s）。
export const MODEL_IO_RETENTION_DAYS = 7;
export const MODEL_IO_CLEANUP_STARTUP_DELAY_MS = 60_000;

const MODEL_IO_FILE_NAME_PATTERN = /^model-io-.+\.jsonl$/;
const MIN_RETENTION_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ModelIoRetentionCleanupOptions {
  logger?: Logger;
  now?: Date;
  retentionDays?: number;
  rootDirs: string[];
}

export interface ModelIoRetentionCleanupResult {
  cutoffMs: number;
  deletedFiles: string[];
  failedFiles: string[];
  retentionDays: number;
  scannedFiles: number;
  status: "completed" | "failed";
}

export interface ModelIoRetentionTimer {
  unref?(): void;
}

export interface ModelIoRetentionScheduleOptions
  extends Omit<ModelIoRetentionCleanupOptions, "now"> {
  delayMs?: number;
  now?: () => Date;
  setTimeout?: (callback: () => void, delayMs: number) => ModelIoRetentionTimer;
}

export async function cleanupModelIoRetention(
  options: ModelIoRetentionCleanupOptions,
): Promise<ModelIoRetentionCleanupResult> {
  const retentionDays = normalizeRetentionDays(options.retentionDays);
  const cutoffMs = (options.now ?? new Date()).getTime() - retentionDays * DAY_MS;
  const result: ModelIoRetentionCleanupResult = {
    cutoffMs,
    deletedFiles: [],
    failedFiles: [],
    retentionDays,
    scannedFiles: 0,
    status: "completed",
  };

  for (const rootDir of options.rootDirs) {
    await cleanupRootDir(rootDir, result, options);
  }

  options.logger?.debug("Model I/O retention cleanup completed", {
    cutoffMs,
    deletedFileCount: result.deletedFiles.length,
    event: "model_io.retention.cleanup.completed",
    failedFileCount: result.failedFiles.length,
    module: "adapters.model",
    retentionDays,
    rootDirs: options.rootDirs,
    scannedFiles: result.scannedFiles,
    status: result.status,
  });
  return result;
}

export function scheduleModelIoRetentionCleanup(
  options: ModelIoRetentionScheduleOptions,
): ModelIoRetentionTimer {
  const delayMs = options.delayMs ?? MODEL_IO_CLEANUP_STARTUP_DELAY_MS;
  const retentionDays = normalizeRetentionDays(options.retentionDays);
  options.logger?.info("Model I/O retention cleanup scheduled", {
    delayMs,
    event: "model_io.retention.cleanup.scheduled",
    module: "adapters.model",
    retentionDays,
    rootDirs: options.rootDirs,
    status: "waiting",
  });
  const scheduleTimer =
    options.setTimeout ?? ((callback: () => void, timeoutMs: number) => setTimeout(callback, timeoutMs));
  const timer = scheduleTimer(() => {
    void cleanupModelIoRetention({
      logger: options.logger,
      now: options.now?.() ?? new Date(),
      retentionDays,
      rootDirs: options.rootDirs,
    });
  }, delayMs);
  timer.unref?.();
  return timer;
}

// session 文件名不含日期（model-io-<sessionId>.jsonl），只能按 mtime 判定新旧；
// 与 logging/retention.ts 的「文件名日期」口径不同，这里以 stat().mtimeMs 为准。
async function cleanupRootDir(
  rootDir: string,
  result: ModelIoRetentionCleanupResult,
  options: ModelIoRetentionCleanupOptions,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (hasFileSystemCode(error, "ENOENT")) {
      // 目录不存在说明还没有产生过 model-io 日志，视为该目录清理完成。
      return;
    }
    result.status = "failed";
    warnCleanupFailed(options, result, rootDir, error);
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !MODEL_IO_FILE_NAME_PATTERN.test(entry.name)) continue;

    result.scannedFiles += 1;
    const filePath = join(rootDir, entry.name);
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(filePath)).mtimeMs;
    } catch (error) {
      if (hasFileSystemCode(error, "ENOENT")) continue;
      result.failedFiles.push(entry.name);
      result.status = "failed";
      warnDeleteFailed(options, result, entry.name, error);
      continue;
    }
    if (mtimeMs >= result.cutoffMs) continue;

    try {
      await unlink(filePath);
      result.deletedFiles.push(entry.name);
    } catch (error) {
      if (hasFileSystemCode(error, "ENOENT")) continue;
      result.failedFiles.push(entry.name);
      result.status = "failed";
      warnDeleteFailed(options, result, entry.name, error);
    }
  }
}

function normalizeRetentionDays(retentionDays: number | undefined): number {
  if (retentionDays === undefined || !Number.isFinite(retentionDays)) return MODEL_IO_RETENTION_DAYS;
  return Math.max(MIN_RETENTION_DAYS, Math.trunc(retentionDays));
}

function warnCleanupFailed(
  options: ModelIoRetentionCleanupOptions,
  result: ModelIoRetentionCleanupResult,
  rootDir: string,
  error: unknown,
): void {
  options.logger?.warn("Model I/O retention cleanup failed", {
    cutoffMs: result.cutoffMs,
    error: summarizeError(error),
    event: "model_io.retention.cleanup.failed",
    module: "adapters.model",
    retentionDays: result.retentionDays,
    rootDir,
    status: "failed",
  });
}

function warnDeleteFailed(
  options: ModelIoRetentionCleanupOptions,
  result: ModelIoRetentionCleanupResult,
  fileName: string,
  error: unknown,
): void {
  options.logger?.warn("Model I/O retention file delete failed", {
    cutoffMs: result.cutoffMs,
    error: summarizeError(error),
    event: "model_io.retention.delete.failed",
    fileName,
    module: "adapters.model",
    retentionDays: result.retentionDays,
    status: "failed",
  });
}

function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      code,
      message: error.message,
      name: error.name,
    };
  }
  return {
    message: String(error),
    name: "UnknownError",
  };
}

function hasFileSystemCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
