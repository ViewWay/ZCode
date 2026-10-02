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
import {
  createAutomationReplayEngine,
  defaultAutomationReplayRunId,
} from "./automationReplayEngine.js";
import {
  createUnavailableBrowserActionExecutor,
  type BrowserActionExecutor,
} from "./automationReplayExecutors.js";
import type { AutomationReplayBrowserSession } from "./automationReplayBrowserSession.js";

/**
 * 浏览器操作录制回放 Host 服务（specs/record-replay.md）。
 *
 * - 存储（~/.zcode/automations/）与回放引擎都属 Desktop 本地 Host 域；这里把两者
 *   组装成 renderer 可直连的 IAutomationRecordingService（ProxyChannel 语义：
 *   错误以 message 跨 RPC 传递）。
 * - 执行面：注入 acquireReplayBrowserSession 时每次回放获取 host 拥有的真实浏览器
 *   会话（结束/失败在 finally 释放）；获取失败回退结构化 unavailable executor——
 *   回放诚实失败，不伪造成功。未注入时使用静态 executor（测试/降级装配）。
 * - 与 Bots 聊天渠道配置（bot-config.v3.json）零交互；定时调度面互不复用。
 */

export interface AutomationRecordingHostServiceDeps {
  /** 录制件根目录（~/.zcode/automations）；缺省由宿主装配传入，测试注入临时目录。 */
  rootDir?: string;
  /** 静态执行面：未提供 acquireReplayBrowserSession 时使用（测试/降级装配）。 */
  executor?: BrowserActionExecutor;
  /**
   * 每次回放获取真实浏览器执行会话（specs/record-replay.md）；runId 与报告对账，
   * 会话 sessionId=automation-replay:<runId>。获取失败由本服务回退 unavailable。
   */
  acquireReplayBrowserSession?: (runId: string) => Promise<AutomationReplayBrowserSession>;
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
  const runIdFactory = deps.newRunId ?? defaultAutomationReplayRunId;
  /** 每次回放新建引擎：runId 预生成（会话 sessionId 对账），executor 按会话获取结果决定。 */
  const buildEngine = (executor: BrowserActionExecutor, runId: string) =>
    createAutomationReplayEngine({
      executor,
      sink: store,
      ...(deps.now ? { now: deps.now } : {}),
      newRunId: () => runId,
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
      const runId = runIdFactory();
      // 会话获取在步骤执行前完成：失败即回退 unavailable executor（报告 executorSurface
      // 说明原因），不带坏链路伪造回放。未注入任何执行面时同样 unavailable 诚实失败。
      let executor =
        deps.executor ??
        createUnavailableBrowserActionExecutor("no browser execution surface wired");
      let release: (() => Promise<void>) | undefined;
      if (deps.acquireReplayBrowserSession) {
        try {
          const session = await deps.acquireReplayBrowserSession(runId);
          executor = session.executor;
          release = session.release;
        } catch (error) {
          const reason = `replay browser session acquisition failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
          log?.warn(`[automation-recording] ${reason}`);
          executor = createUnavailableBrowserActionExecutor(reason);
        }
      }
      try {
        const { report, reportPath } = await buildEngine(executor, runId).replay(
          recording,
          onFailure,
        );
        log?.info(
          `[automation-recording] replay recording=${recordingId} run=${report.runId} ` +
            `status=${report.status} steps=${report.steps.length} report=${reportPath}`,
        );
        return report;
      } finally {
        // 成功/失败/抛错都必须释放回放浏览器会话；释放尽力而为，失败只告警。
        if (release) {
          try {
            await release();
          } catch (error) {
            log?.warn(
              `[automation-recording] replay session release failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }
    },

    async listReports(recordingId: string): Promise<AutomationReplayReport[]> {
      return store.listReports(recordingId);
    },
  };
}
