import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  TrajectoryUsageStats,
  TrajectoryUsageStatsParams,
} from "#src/session/zcodeTaskService.js";
import { resolveModelIODirs } from "#src/zcode-agent/modelTrajectoryFileTail.js";

// 从 modelTrajectory.ts 拆出（修复原因：oxlint max-lines 上限 400，单文件 613 行超限）。
// 本文件只负责跨会话聚合：扫描全部 model-io JSONL 并按模型/工具/会话汇总，无记录映射逻辑。

// ---- 跨会话聚合（对齐 memory-search 理念：结构化分析而非文本检索）----
// 类型（TrajectoryUsageStats/Params）定义在 zcodeTaskService.ts，此处只实现聚合。

/** 单条 model_io 记录的窄读取视图（仅聚合所需字段；损坏行按跳过计）。 */
interface RawModelIoRecord {
  type?: unknown;
  startedAt?: unknown;
  sessionId?: unknown;
  error?: unknown;
  model?: { providerId?: unknown; modelId?: unknown } | null;
  request?: { toolNames?: unknown } | null;
  response?: { usage?: { inputTokens?: unknown; outputTokens?: unknown } | null } | null;
}

function asStatNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asStatString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 跨会话聚合：扫描全部 model-io JSONL（~/.zcode/cli/{debug,rollout}），按模型/工具/
 * 会话聚合调用、错误与 token 用量——对齐 memory-search 的结构化分析理念
 * （聚合/过滤/跨会话模式），但数据源是 ZCode 自己的 model-io 文件而非 SQLite。
 * 损坏行跳过；只读不改。
 */
export async function aggregateModelUsageStats(
  params: TrajectoryUsageStatsParams & { dirs?: string[] } = {},
): Promise<TrajectoryUsageStats> {
  const dirs = params.dirs ?? resolveModelIODirs();
  const sinceMs = params.sinceMs;
  const stats: TrajectoryUsageStats = {
    scannedSessions: 0,
    scannedRecords: 0,
    erroredRecords: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    byModel: [],
    byTool: [],
    bySession: [],
  };
  const byModelKey = new Map<
    string,
    {
      providerId: string;
      modelId: string;
      calls: number;
      errored: number;
      inputTokens: number;
      outputTokens: number;
    }
  >();
  const byToolKey = new Map<string, number>();
  const bySessionKey = new Map<string, { calls: number; errored: number; lastStartedAt: string }>();

  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    const ioFiles = names
      .filter((name) => name.startsWith("model-io-") && name.endsWith(".jsonl"))
      .sort();
    const selected = params.maxSessions ? ioFiles.slice(0, params.maxSessions) : ioFiles;
    for (const name of selected) {
      let text: string;
      try {
        text = await readFile(join(dir, name), "utf8");
      } catch {
        continue;
      }
      const sessionId = name.slice("model-io-".length, -".jsonl".length);
      let sessionRecorded = false;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let record: RawModelIoRecord;
        try {
          record = JSON.parse(line) as RawModelIoRecord;
        } catch {
          continue;
        }
        if (record?.type !== "model_io") continue;
        const startedAtMs = asStatString(record.startedAt)
          ? Date.parse(asStatString(record.startedAt))
          : Number.NaN;
        if (sinceMs !== undefined && (!Number.isFinite(startedAtMs) || startedAtMs < sinceMs)) {
          continue;
        }
        sessionRecorded = true;
        stats.scannedRecords += 1;
        const errored = Boolean(record.error);
        if (errored) stats.erroredRecords += 1;
        const usage = record.response?.usage ?? undefined;
        const inputTokens = asStatNumber(usage?.inputTokens);
        const outputTokens = asStatNumber(usage?.outputTokens);
        stats.totalInputTokens += inputTokens;
        stats.totalOutputTokens += outputTokens;

        const providerId = asStatString(record.model?.providerId) || "unknown";
        const modelId = asStatString(record.model?.modelId) || "unknown";
        const modelKey = `${providerId}/${modelId}`;
        const modelEntry = byModelKey.get(modelKey) ?? {
          providerId,
          modelId,
          calls: 0,
          errored: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
        modelEntry.calls += 1;
        if (errored) modelEntry.errored += 1;
        modelEntry.inputTokens += inputTokens;
        modelEntry.outputTokens += outputTokens;
        byModelKey.set(modelKey, modelEntry);

        const toolNames = Array.isArray(record.request?.toolNames) ? record.request?.toolNames : [];
        for (const tool of toolNames) {
          if (typeof tool !== "string" || tool.length === 0) continue;
          byToolKey.set(tool, (byToolKey.get(tool) ?? 0) + 1);
        }

        const sessionEntry = bySessionKey.get(sessionId) ?? {
          calls: 0,
          errored: 0,
          lastStartedAt: "",
        };
        sessionEntry.calls += 1;
        if (errored) sessionEntry.errored += 1;
        const startedAtIso = asStatString(record.startedAt);
        if (startedAtIso > (sessionEntry.lastStartedAt || "")) {
          sessionEntry.lastStartedAt = startedAtIso;
        }
        bySessionKey.set(sessionId, sessionEntry);
      }
      if (sessionRecorded) stats.scannedSessions += 1;
    }
  }

  stats.byModel = [...byModelKey.values()].sort((a, b) => b.calls - a.calls);
  stats.byTool = [...byToolKey.entries()]
    .map(([tool, calls]) => ({ tool, calls }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 50);
  stats.bySession = [...bySessionKey.entries()]
    .map(([sessionId, entry]) => ({ sessionId, ...entry }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 200);
  return stats;
}
