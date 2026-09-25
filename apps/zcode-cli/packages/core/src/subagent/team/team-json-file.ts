// ============================================================
// Agent Teams - JSON 文件读取工具（缺失即 undefined，不吞其它 IO 错误）
// ============================================================

import { readFile } from "node:fs/promises";

/** 读取 UTF-8 文本；文件不存在返回 undefined，其余 IO 错误向上冒泡。 */
export async function readTextFileSafe(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

/** 读取并解析 JSON；文件不存在返回 undefined，JSON 损坏由调用方按业务校验处理。 */
export async function readJsonFileSafe(filePath: string): Promise<unknown | undefined> {
  const raw = await readTextFileSafe(filePath);
  if (raw === undefined) return undefined;
  return JSON.parse(raw) as unknown;
}
