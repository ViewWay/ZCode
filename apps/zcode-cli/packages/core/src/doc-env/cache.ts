// ============================================================
// 文档技能环境状态缓存（~/.zcode/doc-env.json 唯一写入点）
// ============================================================
// specs/doc-env-bootstrap.md：探测结果缓存于 doc-env.json，checkedAt 超过 7 天或
// soffice 路径失效时由上层（bootstrap）重测。本模块是该文件唯一读写入口：
// - 全部使用异步 fs（node:fs/promises），不用同步 API；
// - 原子写入：同目录临时文件 + rename，读方不会读到半截 JSON；
// - 文件缺失或损坏（非法 JSON / 字段形态不符）一律返回 null，由上层回落重测；
//   本模块不负责"修复"旧缓存。其余错误（如权限）按错误处理规范向上冒泡。
// 注意：缓存路径作用于运行 agent 的宿主机文件系统，按宿主 path 语义拼接
// （区别于 detect.ts 中面向"目标平台"的候选路径构造）。

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const ZCODE_CONFIG_DIR_NAME = ".zcode";
const DOC_ENV_CACHE_FILE_NAME = "doc-env.json";

/** 缓存有效期：checkedAt 距今超过 7 天视为过期（spec）。 */
export const DOC_ENV_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 环境状态（doc-env.json 全量字段；checkedAt 为 ISO 8601，如 "2026-10-02T12:00:00Z"）。 */
export interface DocEnvState {
  sofficePath: string | null;
  version: string | null;
  fontsOk: boolean;
  checkedAt: string;
}

export interface DocEnvCacheOptions {
  /** 覆盖主目录（默认 os.homedir()）；测试注入临时目录。 */
  homeDir?: string;
}

/** 缓存文件路径：<homeDir>/.zcode/doc-env.json。 */
export function resolveDocEnvCachePath(homeDir: string): string {
  return path.join(homeDir, ZCODE_CONFIG_DIR_NAME, DOC_ENV_CACHE_FILE_NAME);
}

/** 读缓存；文件缺失或损坏返回 null，其余错误向上冒泡。 */
export async function readDocEnvCache(options: DocEnvCacheOptions = {}): Promise<DocEnvState | null> {
  let raw: string;
  try {
    raw = await readFile(resolveDocEnvCachePath(options.homeDir ?? homedir()), "utf8");
  } catch (error) {
    // 从未探测过（正常首跑）视为无缓存，触发上层探测；其它读取错误照常冒泡。
    if (isNoEntityError(error)) return null;
    throw error;
  }
  return parseDocEnvState(raw);
}

/** 原子写缓存（唯一写入点）：先建目录，再写同目录 tmp 文件，最后 rename 覆盖。 */
export async function writeDocEnvCache(
  state: DocEnvState,
  options: DocEnvCacheOptions = {},
): Promise<void> {
  const cachePath = resolveDocEnvCachePath(options.homeDir ?? homedir());
  await mkdir(path.dirname(cachePath), { recursive: true });
  const tmpPath = `${cachePath}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmpPath, cachePath);
}

/** checkedAt 距 now 未超过 7 天视为新鲜（恰好 7 天不算"超过"，不触发重测）。 */
export function isDocEnvCacheFresh(state: DocEnvState, now: Date): boolean {
  const checkedAtMs = Date.parse(state.checkedAt);
  if (Number.isNaN(checkedAtMs)) return false;
  return now.getTime() - checkedAtMs <= DOC_ENV_CACHE_TTL_MS;
}

/** 解析并做运行时形态校验（跨存储边界的数据不信任静态类型）。 */
function parseDocEnvState(raw: string): DocEnvState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // 损坏缓存：回落重测
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const { sofficePath, version, fontsOk, checkedAt } = record;
  if (!isNullableString(sofficePath) || !isNullableString(version)) return null;
  if (typeof fontsOk !== "boolean") return null;
  if (typeof checkedAt !== "string" || Number.isNaN(Date.parse(checkedAt))) return null;
  return { sofficePath, version, fontsOk, checkedAt };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNoEntityError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
