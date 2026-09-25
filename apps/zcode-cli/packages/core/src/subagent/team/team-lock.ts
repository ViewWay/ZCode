// ============================================================
// Agent Teams - 跨平台文件锁（mailbox / tasks / TeamFile 互斥写入）
// ============================================================
//
// specs/agent-teams.md：mailbox 写入「使用文件锁（重试 + 指数退避），保证多写者互斥」。
// Windows/macOS/Linux 没有统一 flock 语义，因此用「O_EXCL 独占创建 lock 文件」实现：
//   - 获取：`wx` 标志创建 `<resource>.lock`，内容写入随机 token；
//   - 释放：重读 lock 文件，token 一致才 unlink —— 防止 stale-break 误删他人新锁；
//   - 死锁防护：锁文件超过 STALE_LOCK_AGE_MS 视为陈旧，持锁进程已死，允许打破；
//   - 竞争：按指数退避重试，超过总窗口抛 TeamLockTimeoutError（不静默降级）。

import { randomBytes } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";

const LOCK_FILE_SUFFIX = ".lock";
const LOCK_RETRY_BASE_DELAY_MS = 25;
const LOCK_RETRY_BACKOFF_FACTOR = 1.5;
const LOCK_RETRY_MAX_DELAY_MS = 500;
export const DEFAULT_LOCK_TOTAL_WAIT_MS = 3_000;
/** 超过该年龄的锁视为持锁者已死亡（进程崩溃 / 断电），允许打破。 */
export const STALE_LOCK_AGE_MS = 15_000;

export class TeamLockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string, waitedMs: number) {
    super(`Timed out acquiring team file lock after ${waitedMs}ms: ${lockPath}`);
    this.name = "TeamLockTimeoutError";
    this.lockPath = lockPath;
  }
}

interface LockFilePayload {
  token: string;
  acquiredAt: string;
}

/** 在锁保护下执行互斥区；同一进程内的并发调用者同样互斥（文件锁语义）。 */
export async function withTeamFileLock<T>(
  resourcePath: string,
  fn: () => Promise<T>,
  options: { totalWaitMs?: number } = {},
): Promise<T> {
  const lockPath = `${resourcePath}${LOCK_FILE_SUFFIX}`;
  const release = await acquireTeamFileLock(lockPath, options.totalWaitMs ?? DEFAULT_LOCK_TOTAL_WAIT_MS);
  try {
    return await fn();
  } finally {
    await release();
  }
}

async function acquireTeamFileLock(
  lockPath: string,
  totalWaitMs: number,
): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true });
  const token = randomBytes(16).toString("hex");
  const deadline = Date.now() + totalWaitMs;
  let delayMs = LOCK_RETRY_BASE_DELAY_MS;

  for (;;) {
    const acquired = await tryCreateLockFile(lockPath, token);
    if (acquired) {
      return () => releaseTeamFileLock(lockPath, token);
    }
    await breakStaleLockIfEligible(lockPath);
    if (Date.now() >= deadline) {
      throw new TeamLockTimeoutError(lockPath, totalWaitMs);
    }
    await sleep(Math.min(delayMs, LOCK_RETRY_MAX_DELAY_MS));
    delayMs *= LOCK_RETRY_BACKOFF_FACTOR;
  }
}

async function tryCreateLockFile(lockPath: string, token: string): Promise<boolean> {
  const payload: LockFilePayload = { token, acquiredAt: new Date().toISOString() };
  try {
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(JSON.stringify(payload), "utf8");
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if (isEexist(error)) return false;
    throw error;
  }
}

async function releaseTeamFileLock(lockPath: string, token: string): Promise<void> {
  try {
    const current = await readFile(lockPath, "utf8");
    const payload = JSON.parse(current) as Partial<LockFilePayload>;
    // token 不一致说明自己的锁已被 stale-break 且别人已重新拿锁；此时绝不能删别人的锁。
    if (payload.token !== token) return;
  } catch {
    // 锁文件已消失（被 stale-break）也算释放成功。
    return;
  }
  try {
    await unlink(lockPath);
  } catch {
    // 已被并发释放；释放失败不影响互斥区结果。
  }
}

async function breakStaleLockIfEligible(lockPath: string): Promise<void> {
  try {
    const info = await stat(lockPath);
    const ageMs = Date.now() - info.mtimeMs;
    if (ageMs < STALE_LOCK_AGE_MS) return;
    // 竞态容忍：两个等待者同时打破陈旧锁时，后创建者胜出，先创建者会在下一轮 EEXIST 重试。
    await unlink(lockPath);
  } catch {
    // 锁刚被释放或已被人重建；按正常竞争继续。
  }
}

function isEexist(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 测试与存储层共用的工具：避免每个调用点各自拼锁路径。 */
export function joinLockResource(dir: string, fileName: string): string {
  return join(dir, fileName);
}
