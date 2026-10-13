import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ZCodeModelTrajectory } from "#src/session/zcodeTaskService.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  readTrajectoryFileTail,
  resolveModelIODirs,
  sanitizeSessionSegment,
} from "#src/zcode-agent/modelTrajectoryFileTail.js";
import type { TrajectoryFileTail } from "#src/zcode-agent/modelTrajectoryFileTail.js";
// 修复原因：oxlint max-lines 上限 400，本文件曾达 613 行。把“JSONL 记录 → 轨迹对象”
// 的映射层拆到 modelTrajectoryMapping.ts、跨会话聚合拆到 modelTrajectoryAggregate.ts；
// 本文件只保留读取入口，对外导出（readModelTrajectory / aggregateModelUsageStats）不变。
import {
  asString,
  expandModelIODeltaRecords,
  mapRecord,
  toTime,
} from "#src/zcode-agent/modelTrajectoryMapping.js";
import { aggregateModelUsageStats } from "#src/zcode-agent/modelTrajectoryAggregate.js";

export { aggregateModelUsageStats };

// model-io 默认最多返回的调用条数（保留最近 N 条），避免长 session 把 UI 压垮。
const DEFAULT_TRAJECTORY_LIMIT = 200;
const logger = createServiceLogger("model-trajectory");

/**
 * 解析 ~/.zcode/cli/{debug,rollout} 下的 model-io JSONL，按 sessionId 还原某个 task 的模型调用轨迹。
 *
 * 设计说明：
 * - model-io 由 adapters/model/runner-debug.ts 落盘；一个 session 一个
 *   `model-io-<sanitizedSessionId>.jsonl`。
 * - ZCode Agent 把 taskId 当作 sessionId（见 zcodeTaskServiceAdapter），所以这里只读取
 *   该 session 的单文件，并按 `record.sessionId === taskId` 精确匹配。
 */
export async function readModelTrajectory(
  taskId: string,
  limit = DEFAULT_TRAJECTORY_LIMIT,
): Promise<ZCodeModelTrajectory> {
  const safeLimit =
    Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : DEFAULT_TRAJECTORY_LIMIT;
  const sanitized = sanitizeSessionSegment(taskId);
  const dirs = resolveModelIODirs();
  const sourceFiles: string[] = [];
  const rawRecords: Record<string, unknown>[] = [];
  let inputTruncated = false;

  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      // 目录不存在（没跑过对应模式）或不可读，跳过。
      continue;
    }

    const fileName = `model-io-${sanitized || "no-session"}.jsonl`;
    const candidates = names.includes(fileName) ? [fileName] : [];

    for (const name of candidates) {
      const filePath = join(dir, name);
      let tail: TrajectoryFileTail;
      const startedAt = Date.now();
      try {
        // 同步读取并 split 整个 model-io 会阻塞 Host 事件循环，并在大文件上制造多份字符串峰值。
        // 从尾部异步读取固定上限；若从行中间开始，则由 readTrajectoryFileTail 丢弃不完整残行。
        tail = await readTrajectoryFileTail(filePath);
        logger.debug(
          undefined,
          `read taskId=${taskId} bytes=${tail.bytesRead} truncated=${tail.truncated} durationMs=${Date.now() - startedAt}`,
        );
      } catch (error) {
        logger.debug(undefined, `read failed taskId=${taskId} file=${filePath}`, error);
        continue;
      }
      inputTruncated ||= tail.truncated;

      let matchedInFile = false;
      for (const line of tail.text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (parsed.type !== "model_io" || parsed.sessionId !== taskId) {
          continue;
        }
        rawRecords.push(parsed);
        matchedInFile = true;
      }

      if (matchedInFile) {
        sourceFiles.push(filePath);
      }
    }
  }

  // 按开始时间排序；同毫秒/缺失时间时按 requestId 兜底，保证顺序稳定。
  rawRecords.sort((left, right) => {
    const startDiff = toTime(asString(left.startedAt)) - toTime(asString(right.startedAt));
    if (startDiff !== 0) {
      return startDiff;
    }
    return (asString(left.requestId) ?? "").localeCompare(asString(right.requestId) ?? "");
  });

  const records = expandModelIODeltaRecords(rawRecords).map((record) => mapRecord(record));
  const truncated = inputTruncated || records.length > safeLimit;
  const trimmedRecords = truncated ? records.slice(records.length - safeLimit) : records;

  return {
    taskId,
    available: true,
    records: trimmedRecords,
    sourceFiles,
    truncated,
  };
}
