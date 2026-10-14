import { renameSync } from "node:fs";
import { rename } from "node:fs/promises";

// feedback#1018（已核实）：Windows 上过滤驱动类杀软会在插件安装时短暂锁定目录，
// 嵌套 zip 拍平后的连环 rename（target→backup、staged→target、backup→target）撞上
// 毫秒级瞬时锁就必现 EPERM，此前所有 rename 都只有单次尝试、没有任何重试。
// npm/yarn 的同型问题最终都以短退避重试收场。这里与 bootstrap 的
// official-plugin-cache-fs 保持同一口径：仅对 EPERM/EBUSY/EACCES 这类短暂占用
// 错误做有界重试，退避指数增长（全表 ≈8s 总预算），耗尽后抛最后一个错误。
export const RENAME_RETRY_DELAYS_MS = [30, 60, 120, 250, 500, 1000, 2000, 4000] as const;

// 同步恢复路径（recoverAtomicTargetSync）跑在读取/修复链路上，重试期间会阻塞
// 事件循环，不能照搬异步全表，用短退避（最长阻塞 ≈210ms）吸收过滤驱动瞬时锁。
export const RENAME_SYNC_RETRY_DELAYS_MS = [30, 60, 120] as const;

export const RENAME_RETRY_ATTEMPTS_FIELD = "zcodeRenameRetryAttempts";

export function isRetryableRenameError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

export async function renameWithRetry(from: string, to: string): Promise<void> {
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      await rename(from, to);
      return;
    } catch (error) {
      markRenameRetryAttempts(error, attempts);
      const delayMs = RENAME_RETRY_DELAYS_MS[attempts - 1];
      if (delayMs === undefined || !isRetryableRenameError(error)) throw error;
      await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, delayMs));
    }
  }
}

export function renameSyncWithRetry(from: string, to: string): void {
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      markRenameRetryAttempts(error, attempts);
      const delayMs = RENAME_SYNC_RETRY_DELAYS_MS[attempts - 1];
      if (delayMs === undefined || !isRetryableRenameError(error)) throw error;
      sleepSyncMs(delayMs);
    }
  }
}

function markRenameRetryAttempts(error: unknown, attempts: number): void {
  if (typeof error !== "object" || error === null) return;
  try {
    Object.defineProperty(error, RENAME_RETRY_ATTEMPTS_FIELD, {
      configurable: true,
      value: attempts,
      writable: true,
    });
  } catch {
    // 某些错误对象可能被冻结；此时调用方读不到 attempts，按 1 次尝试理解即可，
    // 不因附加诊断字段掩盖原始异常。
  }
}

function sleepSyncMs(delayMs: number): void {
  // 同步链路没有可用的异步 sleep；与 bootstrap official-plugin-cache-fs 一致，
  // 用 Atomics.wait 做有界阻塞等待。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}
