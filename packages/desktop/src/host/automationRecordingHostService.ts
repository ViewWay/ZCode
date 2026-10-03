import type {
  AutomationRecording,
  AutomationRecordingCaptureStartParams,
  AutomationRecordingCaptureState,
  AutomationRecordingSaveParams,
  AutomationRecordingStep,
  AutomationReplayOnFailure,
  AutomationReplayReport,
} from "@zcode/shared";
import { computeNextRunAt, isValidCronExpr } from "@zcode/services";
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
import type { AutomationCaptureHandle } from "./automationCaptureSession.js";

/**
 * 浏览器操作录制回放 Host 服务（specs/record-replay.md）。
 *
 * - 存储（~/.zcode/automations/）与回放引擎都属 Desktop 本地 Host 域；这里把两者
 *   组装成 renderer 可直连的 IAutomationRecordingService（ProxyChannel 语义：
 *   错误以 message 跨 RPC 传递）。
 * - 执行面：注入 acquireReplayBrowserSession 时每次回放获取 host 拥有的真实浏览器
 *   会话（结束/失败在 finally 释放）；获取失败回退结构化 unavailable executor——
 *   回放诚实失败，不伪造成功。未注入时使用静态 executor（测试/降级装配）。
 * - 实时采集（v1.1）：活动采集会话的唯一所有者；同一时刻至多一个，
 *   createCaptureSession 未装配时 startCapture 诚实失败。
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
  /**
   * 创建实时采集会话（v1.1）；宿主装配传入（browserControlMainBridge + workspace）。
   * preflight/newTab 失败由会话工厂抛错，本服务原样透出（诚实失败）。
   */
  createCaptureSession?: () => Promise<AutomationCaptureHandle>;
  /** 进度日志；复用 host 进程 logger（writeHostLog）。 */
  logger?: Pick<Console, "info" | "warn" | "error">;
  store?: AutomationRecordingStore;
  now?: () => number;
  newRunId?: () => string;
  delay?: (ms: number) => Promise<void>;
  /**
   * 定时回放（v1.2）：调度滴答间隔；**缺省 0=停用**（测试免悬挂句柄），
   * 宿主装配显式传入 60_000 启用。0 时可直调 runScheduledReplayCheck 驱动。
   */
  scheduleTickMs?: number;
  /** cron 下次触发时间计算注入（默认 @zcode/services 的 computeNextRunAt）。 */
  computeNextRunAtFn?: (cronExpr: string, from?: number) => number | null;
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
): IAutomationRecordingService & {
  runScheduledReplayCheck(): Promise<void>;
  dispose(): void;
} {
  const store = resolveStore(deps);
  const log = deps.logger;
  const runIdFactory = deps.newRunId ?? defaultAutomationReplayRunId;
  const computeDueAt = deps.computeNextRunAtFn ?? computeNextRunAt;
  /** 活动采集会话（唯一所有者）；同一时刻至多一个。 */
  let activeCapture: { handle: AutomationCaptureHandle; title?: string } | undefined;
  /** 定时回放在途集合（防同录制件重入）。 */
  const inFlightReplays = new Set<string>();
  /** 每次回放新建引擎：runId 预生成（会话 sessionId 对账），executor 按会话获取结果决定。 */
  const buildEngine = (executor: BrowserActionExecutor, runId: string) =>
    createAutomationReplayEngine({
      executor,
      sink: store,
      ...(deps.now ? { now: deps.now } : {}),
      newRunId: () => runId,
      ...(deps.delay ? { delay: deps.delay } : {}),
    });

  const service = {
    async list(): Promise<AutomationRecording[]> {
      const { recordings, failures } = await store.list();
      for (const failure of failures) {
        // 单个损坏文件不阻塞列表（定时 tick 与 UI 共用）；提示定位/删除。
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

    async startCapture(
      params?: AutomationRecordingCaptureStartParams,
    ): Promise<AutomationRecordingCaptureState> {
      if (!deps.createCaptureSession) {
        // 宿主未装配采集面（远端/降级装配）：诚实失败，不静默假装录制。
        throw new Error("browser capture is unavailable in this host");
      }
      if (activeCapture) {
        throw new Error("a browser capture session is already running");
      }
      const title = params?.title?.trim() || undefined;
      // 先清占位再创建：工厂失败（preflight/newTab 拒绝）不留半开会话，错误原样透出。
      const handle = await deps.createCaptureSession();
      activeCapture = { handle, ...(title ? { title } : {}) };
      log?.info(
        `[automation-capture] session registered capture=${handle.captureId} title=${title ?? "<untitled>"}`,
      );
      return handle.state();
    },

    async getCaptureState(): Promise<AutomationRecordingCaptureState | null> {
      return activeCapture ? activeCapture.handle.state() : null;
    },

    async stopCapture(): Promise<AutomationRecording> {
      const current = activeCapture;
      if (!current) throw new Error("no active browser capture session");
      // 先摘除活动会话再收尾：停止期间的 getCaptureState 不再报告录制中，
      // stopCapture 自身失败也不留僵尸占用（会话内部已尽力释放）。
      activeCapture = undefined;
      let steps: AutomationRecordingStep[];
      try {
        steps = await current.handle.stop();
      } catch (error) {
        log?.warn(
          `[automation-capture] stop failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
      if (steps.length === 0) {
        // 空步骤不落库（schema 也要求 steps>=1）：拒绝保存并明确原因。
        throw new Error("no steps captured; recording was not saved");
      }
      const recording = await store.save({
        ...(current.title ? { title: current.title } : {}),
        source: "browser",
        steps,
      });
      log?.info(
        `[automation-capture] saved capture=${current.handle.captureId} as recording=${recording.id} steps=${steps.length}`,
      );
      return recording;
    },

    async cancelCapture(): Promise<boolean> {
      const current = activeCapture;
      if (!current) throw new Error("no active browser capture session");
      activeCapture = undefined;
      await current.handle.cancel();
      log?.info(`[automation-capture] cancelled capture=${current.handle.captureId}`);
      return true;
    },

    async setSchedule(
      recordingId: string,
      schedule: { cronExpr: string; enabled: boolean } | undefined,
    ): Promise<AutomationRecording> {
      if (schedule && schedule.enabled && !isValidCronExpr(schedule.cronExpr)) {
        throw new Error(`invalid cron expression: ${schedule.cronExpr}`);
      }
      // enabled 且表达式合法才写入；undefined=清除调度；enabled=false=保留表达式暂停。
      const recording = await store.update(recordingId, {
        ...(schedule === undefined ? { schedule: null } : { schedule }),
      });
      log?.info(
        `[automation-recording] schedule recording=${recordingId} ` +
          `cron=${schedule?.cronExpr ?? "<cleared>"} enabled=${schedule?.enabled ?? false}`,
      );
      return recording;
    },

    /** 定时回放检查（单次）；定时器与测试共用。到期即置 lastReplayStartedAt 并回放。 */
    async runScheduledReplayCheck(): Promise<void> {
      let recordings: AutomationRecording[];
      try {
        ({ recordings } = await store.list());
      } catch {
        return;
      }
      const nowMs = deps.now?.() ?? Date.now();
      const fires: Promise<void>[] = [];
      for (const recording of recordings) {
        const schedule = recording.schedule;
        if (!schedule?.enabled || !isValidCronExpr(schedule.cronExpr)) continue;
        if (inFlightReplays.has(recording.id)) continue;
        const from = recording.lastReplayStartedAt ?? Date.parse(recording.createdAt);
        const dueAt = computeDueAt(schedule.cronExpr, Number.isFinite(from) ? from : undefined);
        if (dueAt === null || dueAt > nowMs) continue;
        inFlightReplays.add(recording.id);
        // 收集在途回放：定时器走 void 不阻塞滴答；测试直调本方法可确定性等待完成。
        fires.push(
          (async () => {
            try {
              // 先落时间戳防重入；skip 策略适配无人值守（单步失败不中断整轮）。
              await store.update(recording.id, { lastReplayStartedAt: nowMs });
              log?.info(
                `[automation-recording] scheduled replay due recording=${recording.id} cron=${schedule.cronExpr}`,
              );
              await service.replay(recording.id, { onFailure: "skip" });
            } catch (error) {
              log?.warn(
                `[automation-recording] scheduled replay failed recording=${recording.id}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            } finally {
              inFlightReplays.delete(recording.id);
            }
          })(),
        );
      }
      await Promise.allSettled(fires);
    },

    /** 停止定时回放滴答（宿主资源收口时调用）。 */
    dispose(): void {
      if (scheduleTimer !== undefined) {
        clearInterval(scheduleTimer);
        scheduleTimer = undefined;
      }
    },
  };

  const scheduleTickMs = deps.scheduleTickMs ?? 0;
  let scheduleTimer: ReturnType<typeof setInterval> | undefined;
  if (scheduleTickMs > 0) {
    scheduleTimer = setInterval(() => void service.runScheduledReplayCheck(), scheduleTickMs);
  }
  return service;
}
