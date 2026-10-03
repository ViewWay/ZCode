import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  automationRecordingSchema,
  parseAutomationRecordingJson,
  parseAutomationReplayReportJson,
  type AutomationRecording,
  type AutomationRecordingSaveParams,
  type AutomationRecordingSource,
  type AutomationReplayReport,
} from "@zcode/shared";

/**
 * 浏览器操作录制件存储层（specs/record-replay.md）。
 *
 * - 唯一写入点：录制件 = <rootDir>/<id>.json；回放报告 = <rootDir>/reports/<recordingId>/<runId>.json。
 *   rootDir 必填（宿主装配时传 {dataBaseDir}/.zcode/automations；测试注入临时目录），
 *   模块本身不解析用户目录，避免把 services/node 的重依赖拖进单测。
 * - 原子写：staging 文件 + rename（Windows rename 不能覆盖已存在文件，先 rm 目标再提交，
 *   与 browserRecordingArtifactMaterializer 同范式）；staging 残留统一清理。
 * - 损坏文件（非法 JSON / schema 不通过）读取即抛错，调用方整体拒绝，不允许部分执行。
 * - 只用异步 fs；路径拼接走 node:path，跨平台。
 */

const RECORDING_FILE_SUFFIX = ".json";

/** 录制件 id 字符集与 shared schema 一致；此处提前拦截，避免拼进文件路径。 */
const RECORDING_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;

export class AutomationRecordingStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_id"
      | "not_found"
      | "corrupt_recording"
      | "corrupt_report"
      | "write_failed",
  ) {
    super(message);
    this.name = "AutomationRecordingStoreError";
  }
}

export interface AutomationRecordingStore {
  /** 全部录制件（按 createdAt 新→旧）。损坏文件跳过并计入返回的 failures（不中断列表）。 */
  list(): Promise<{
    recordings: AutomationRecording[];
    /** 读取失败（损坏/不可读）的文件名与原因，供 UI/日志提示。 */
    failures: Array<{ file: string; error: string }>;
  }>;
  get(recordingId: string): Promise<AutomationRecording>;
  /** 保存录制件；id/createdAt 由存储层生成。steps 必须已通过 schema 校验。 */
  save(params: AutomationRecordingSaveParams): Promise<AutomationRecording>;
  /**
   * 读-改-写更新录制件元数据（原子写 + schema 复解析）。
   * schedule: null = 清除调度（删除该键）；对象 = 设置/更新。
   */
  update(
    recordingId: string,
    patch: {
      schedule?: { cronExpr: string; enabled: boolean } | null;
      lastReplayStartedAt?: number;
    },
  ): Promise<AutomationRecording>;
  /** 删除录制件与其全部回放报告；返回是否删除了录制件本体。 */
  delete(recordingId: string): Promise<boolean>;
  /** 保存回放报告，返回报告文件绝对路径。 */
  saveReport(report: AutomationReplayReport): Promise<string>;
  /** 保存失败截图（base64 png），返回截图文件绝对路径。 */
  saveScreenshot(
    recordingId: string,
    runId: string,
    seq: number,
    base64Png: string,
  ): Promise<string>;
  /** 某录制件的回放报告列表（finishedAt 新→旧）。 */
  listReports(recordingId: string): Promise<AutomationReplayReport[]>;
}

function assertRecordingId(recordingId: string): void {
  if (!RECORDING_ID_PATTERN.test(recordingId)) {
    throw new AutomationRecordingStoreError(
      `invalid automation recording id: ${recordingId}`,
      "invalid_id",
    );
  }
}

/** 原子写：同目录 staging + rename；Windows 需先移除已存在目标。 */
async function atomicWriteFile(targetPath: string, data: string): Promise<void> {
  const stagingPath = `${targetPath}.zcode-automation-${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(stagingPath, data, "utf8");
    await rm(targetPath, { force: true });
    await rename(stagingPath, targetPath);
  } finally {
    await rm(stagingPath, { force: true }).catch(() => undefined);
  }
}

function toCorruptError(file: string, error: unknown): AutomationRecordingStoreError {
  return new AutomationRecordingStoreError(
    `${file}: ${error instanceof Error ? error.message : String(error)}`,
    "corrupt_recording",
  );
}

export function createAutomationRecordingStore(deps: {
  rootDir: string;
  now?: () => Date;
  newId?: () => string;
}): AutomationRecordingStore {
  const rootDir = deps.rootDir;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => `rec-${randomUUID()}`);
  const recordingsDir = rootDir;
  const reportsRoot = join(rootDir, "reports");

  const recordingPath = (recordingId: string): string =>
    join(recordingsDir, `${recordingId}${RECORDING_FILE_SUFFIX}`);
  const reportsDir = (recordingId: string): string => join(reportsRoot, recordingId);

  return {
    async list() {
      const failures: Array<{ file: string; error: string }> = [];
      const recordings: AutomationRecording[] = [];
      let entries: string[];
      try {
        entries = await readdir(recordingsDir);
      } catch {
        // 目录不存在 = 无录制件；其它错误按空列表处理，由 get/save 各自暴露真实错误。
        return { recordings, failures };
      }
      for (const entry of entries.sort()) {
        if (!entry.endsWith(RECORDING_FILE_SUFFIX)) continue;
        try {
          const text = await readFile(join(recordingsDir, entry), "utf8");
          recordings.push(parseAutomationRecordingJson(text));
        } catch (error) {
          failures.push({
            file: entry,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      recordings.sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      );
      return { recordings, failures };
    },

    async get(recordingId) {
      assertRecordingId(recordingId);
      let text: string;
      try {
        text = await readFile(recordingPath(recordingId), "utf8");
      } catch {
        throw new AutomationRecordingStoreError(
          `automation recording not found: ${recordingId}`,
          "not_found",
        );
      }
      try {
        return parseAutomationRecordingJson(text);
      } catch (error) {
        throw toCorruptError(recordingId, error);
      }
    },

    async save(params) {
      const source: AutomationRecordingSource = params.source ?? "browser";
      const recording: AutomationRecording = automationRecordingSchema.parse({
        id: newId(),
        ...(params.title?.trim() ? { title: params.title.trim() } : {}),
        createdAt: now().toISOString(),
        source,
        steps: params.steps,
      });
      try {
        await atomicWriteFile(recordingPath(recording.id), JSON.stringify(recording, null, 2));
      } catch (error) {
        throw new AutomationRecordingStoreError(
          `failed to write automation recording ${recording.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "write_failed",
        );
      }
      return recording;
    },

    async update(
      recordingId: string,
      patch: {
        schedule?: { cronExpr: string; enabled: boolean } | null;
        lastReplayStartedAt?: number;
      },
    ): Promise<AutomationRecording> {
      assertRecordingId(recordingId);
      // 读-改-写同一原子写；schedule: null = 清除调度（删除该键），对象 = 设置/更新。
      const current = await (async () => {
        const text = await readFile(recordingPath(recordingId), "utf8");
        return parseAutomationRecordingJson(text);
      })();
      const base = { ...current } as Record<string, unknown>;
      if (patch.schedule === null) {
        delete base.schedule;
      } else if (patch.schedule !== undefined) {
        base.schedule = patch.schedule;
      }
      if (patch.lastReplayStartedAt !== undefined) {
        base.lastReplayStartedAt = patch.lastReplayStartedAt;
      }
      const next = automationRecordingSchema.parse(base);
      try {
        await atomicWriteFile(recordingPath(recordingId), JSON.stringify(next, null, 2));
      } catch (error) {
        throw new AutomationRecordingStoreError(
          `failed to update automation recording ${recordingId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "write_failed",
        );
      }
      return next;
    },

    async delete(recordingId) {
      assertRecordingId(recordingId);
      // rm force 会吞掉 ENOENT，无法区分“删掉了”和“本来就没有”；先 stat 确认存在性。
      let exists = true;
      try {
        const info = await stat(recordingPath(recordingId));
        exists = info.isFile();
      } catch {
        exists = false;
      }
      if (exists) {
        await rm(recordingPath(recordingId), { force: true });
      }
      // 报告目录尽力清理；失败不影响删除语义（录制件本体已删）。
      await rm(reportsDir(recordingId), { recursive: true, force: true }).catch(() => undefined);
      return exists;
    },

    async saveReport(report) {
      const path = join(reportsDir(report.recordingId), `${report.runId}.json`);
      try {
        await atomicWriteFile(path, JSON.stringify(report, null, 2));
      } catch (error) {
        throw new AutomationRecordingStoreError(
          `failed to write replay report ${report.runId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "write_failed",
        );
      }
      return path;
    },

    async saveScreenshot(recordingId, runId, seq, base64Png) {
      const path = join(reportsDir(recordingId), `${runId}-step-${seq}.png`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(base64Png, "base64"));
      return path;
    },

    async listReports(recordingId) {
      assertRecordingId(recordingId);
      const dir = reportsDir(recordingId);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return [];
      }
      const reports: AutomationReplayReport[] = [];
      for (const entry of entries.sort().reverse()) {
        if (!entry.endsWith(RECORDING_FILE_SUFFIX)) continue;
        try {
          reports.push(parseAutomationReplayReportJson(await readFile(join(dir, entry), "utf8")));
        } catch {
          // 单个损坏报告跳过：列表只展示可解析的报告，不因一份脏文件整体失败。
        }
      }
      reports.sort((a, b) => b.finishedAt - a.finishedAt);
      return reports;
    },
  };
}
