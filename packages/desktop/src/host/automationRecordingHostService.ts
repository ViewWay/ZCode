import type {
  AutomationRecording,
  AutomationRecordingSaveParams,
  AutomationReplayOnFailure,
  AutomationReplayReport,
} from "@zcode/shared";
import type { IAutomationRecordingService } from "@zcode/services";
import {
  createAutomationRecordingStore,
  type AutomationRecordingStore,
} from "./automationRecordingStore.js";
import { createAutomationReplayEngine } from "./automationReplayEngine.js";
import type { BrowserActionExecutor } from "./automationReplayExecutors.js";

/**
 * 浏览器操作录制回放 Host 服务（specs/record-replay.md）。
 *
 * - 存储（~/.zcode/automations/）与回放引擎都属 Desktop 本地 Host 域；这里把两者
 *   组装成 renderer 可直连的 IAutomationRecordingService（ProxyChannel 语义：
 *   错误以 message 跨 RPC 传递）。
 * - 执行面注入：宿主未接线真实受控浏览器执行 API 时，传入结构化 unavailable
 *   executor——回放诚实失败，不伪造成功。
 * - 与 Bots 聊天渠道配置（bot-config.v3.json）零交互；定时调度面互不复用。
 */

export interface AutomationRecordingHostServiceDeps {
  /** 录制件根目录（~/.zcode/automations）；缺省由宿主装配传入，测试注入临时目录。 */
  rootDir?: string;
  executor: BrowserActionExecutor;
  /** 进度日志；复用 host 进程 logger（writeHostLog）。 */
  logger?: Pick<Console, "info" | "warn" | "error">;
  store?: AutomationRecordingStore;
  now?: () => number;
  newRunId?: () => string;
  delay?: (ms: number) => Promise<void>;
}

/** rootDir 与 store 至少提供一个；直接收口为显式错误，避免装配期静默落错目录。 */
function resolveStore(deps: AutomationRecordingHostServiceDeps): AutomationRecordingStore {
  if (deps.store) return deps.store;
  if (!deps.rootDir) {
    throw new Error("AutomationRecordingHostService requires rootDir or store");
  }
  return createAutomationRecordingStore({ rootDir: deps.rootDir });
}

export function createAutomationRecordingHostService(
  deps: AutomationRecordingHostServiceDeps,
): IAutomationRecordingService {
  const store = resolveStore(deps);
  const log = deps.logger;
  const replayEngine = createAutomationReplayEngine({
    executor: deps.executor,
    sink: store,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.newRunId ? { newRunId: deps.newRunId } : {}),
    ...(deps.delay ? { delay: deps.delay } : {}),
  });

  return {
    async list(): Promise<AutomationRecording[]> {
      const { recordings, failures } = await store.list();
      for (const failure of failures) {
        // 单个损坏文件不阻塞列表；提示出来让用户可以定位/删除。
        log?.warn(`[automation-recording] skip corrupt file ${failure.file}: ${failure.error}`);
      }
      return recordings;
    },

    async get(recordingId: string): Promise<AutomationRecording | null> {
      try {
        return await store.get(recordingId);
      } catch (error) {
        // not_found 归一为 null（UI 语义）；损坏文件保持抛错（回放/展示必须整体拒绝）。
        if (error instanceof Error && (error as { code?: string }).code === "not_found") {
          return null;
        }
        throw error;
      }
    },

    async save(params: AutomationRecordingSaveParams): Promise<AutomationRecording> {
      const recording = await store.save(params);
      log?.info(
        `[automation-recording] saved recording=${recording.id} steps=${recording.steps.length}`,
      );
      return recording;
    },

    async delete(recordingId: string): Promise<boolean> {
      const removed = await store.delete(recordingId);
      if (removed) {
        log?.info(`[automation-recording] deleted recording=${recordingId}`);
      }
      return removed;
    },

    async replay(
      recordingId: string,
      options?: { onFailure?: AutomationReplayOnFailure },
    ): Promise<AutomationReplayReport> {
      // 录制件损坏/不存在在此整体拒绝：store.get 抛错直接跨 RPC 透出，
      // 引擎不会执行任何步骤（验收场景 3：损坏拒绝执行而非部分执行）。
      const recording = await store.get(recordingId);
      const onFailure: AutomationReplayOnFailure = options?.onFailure ?? "abort";
      const { report, reportPath } = await replayEngine.replay(recording, onFailure);
      log?.info(
        `[automation-recording] replay recording=${recordingId} run=${report.runId} ` +
          `status=${report.status} steps=${report.steps.length} report=${reportPath}`,
      );
      return report;
    },

    async listReports(recordingId: string): Promise<AutomationReplayReport[]> {
      return store.listReports(recordingId);
    },
  };
}
