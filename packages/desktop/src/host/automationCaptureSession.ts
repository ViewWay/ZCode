import { randomUUID } from "node:crypto";
import type {
  AutomationRecordingCaptureState,
  AutomationRecordingStep,
  BrowserCommand,
  BrowserCommandResult,
} from "@zcode/shared";
import type { AutomationCaptureRawEvent } from "@zcode/shared";
import {
  buildAutomationCaptureDrainExpression,
  parseAutomationCaptureDrainResult,
} from "./automationCaptureEvents.js";
import {
  mapCaptureEventsToSteps,
  type CaptureMappingOptions,
} from "./automationCaptureStepMapper.js";

/**
 * 实时采集会话（specs/record-replay.md v1.1）：复用回放会话同款 scope 机制
 * （sessionId=automation-record:<captureId>），全部命令经 browserControlMainBridge
 * 既有执行链路派发，零 main 侧改动。
 *
 * - 启动：preflight list → newTab（用户在嵌入面板内自行导航）→ activateTab +
 *   browserVisibilitySet(true)（尽力而为）→ 首次 drain 安装页面采集脚本。
 * - 轮询：每 pollIntervalMs drain 一次（自安装表达式）；URL 与上次不同时补一条
 *   navigate 事件（SPA pushState 兜底）；drain 失败只告警，下轮重试。
 * - 停止/取消都必经 release（visibility 复位 + close scope tabs，尽力而为）。
 */

/** 采集会话执行端口；与 browserControlMainBridge.execute 的（可选字段）入参结构兼容。 */
export interface AutomationCaptureBrowserPort {
  execute(input: {
    sessionId: string;
    workspaceKey?: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    command: BrowserCommand;
  }): Promise<BrowserCommandResult>;
}

export interface AutomationCaptureWorkspace {
  workspaceKey?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
}

export interface AutomationCaptureSessionDeps {
  port: AutomationCaptureBrowserPort;
  workspace?: AutomationCaptureWorkspace;
  logger?: Pick<Console, "info" | "warn">;
  now?: () => number;
  pollIntervalMs?: number;
  mapping?: CaptureMappingOptions;
  newCaptureId?: () => string;
}

export interface AutomationCaptureHandle {
  readonly captureId: string;
  readonly sessionId: string;
  state(): AutomationRecordingCaptureState;
  /** 最终 drain（尽力而为）→ 停表 → 释放；返回映射后的步骤（可能为空，由调用方决定保存语义）。 */
  stop(): Promise<AutomationRecordingStep[]>;
  /** 丢弃采集并释放；不落库。 */
  cancel(): Promise<void>;
}

/** sessionId 前缀：采集 scope 与回放/agent 会话天然隔离，日志可直接对账。 */
export const AUTOMATION_CAPTURE_SESSION_PREFIX = "automation-record:";

export function buildAutomationCaptureSessionId(captureId: string): string {
  return `${AUTOMATION_CAPTURE_SESSION_PREFIX}${captureId}`;
}

/** 默认轮询间隔：事件延迟上限约 1s，与导航重装窗口对齐（spec 契约值）。 */
export const DEFAULT_CAPTURE_POLL_INTERVAL_MS = 1_000;

/** 会话级原始事件上限：限制内存占用；达到后丢弃新事件并告警一次（尽力采集语义）。 */
const SESSION_EVENT_LIMIT = 5_000;

interface ActiveCapture {
  captureId: string;
  sessionId: string;
  startedAtIso: string;
  events: AutomationCaptureRawEvent[];
  lastUrl: string | null;
  eventOverflowWarned: boolean;
}

/**
 * 启动采集会话。preflight/newTab 失败抛结构化错误（诚实失败，不创建半开会话）；
  activateTab/可见性/首次 drain 失败不致命（轮询自愈），只告警。
 */
export async function startAutomationCaptureSession(
  deps: AutomationCaptureSessionDeps,
): Promise<AutomationCaptureHandle> {
  const captureId = deps.newCaptureId?.() ?? `cap-${randomUUID()}`;
  const sessionId = buildAutomationCaptureSessionId(captureId);
  const now = deps.now ?? (() => Date.now());
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_CAPTURE_POLL_INTERVAL_MS;
  const drainExpression = buildAutomationCaptureDrainExpression();

  const dispatch = (command: BrowserCommand): Promise<BrowserCommandResult> =>
    deps.port.execute({
      sessionId,
      ...(deps.workspace?.workspaceKey ? { workspaceKey: deps.workspace.workspaceKey } : {}),
      ...(deps.workspace?.workspacePath ? { workspacePath: deps.workspace.workspacePath } : {}),
      ...(deps.workspace?.workspaceIdentity
        ? { workspaceIdentity: deps.workspace.workspaceIdentity }
        : {}),
      command,
    });

  // preflight：与回放会话同语义，链路不通即整体拒绝。
  const preflight = await dispatch({ method: "list" });
  if (!preflight.ok) {
    throw new Error(
      `capture browser session preflight failed: ${
        preflight.error ? `${preflight.error.code}: ${preflight.error.message}` : "unknown_error"
      }`,
    );
  }

  const newTabResult = await dispatch({ method: "newTab" });
  if (!newTabResult.ok || !newTabResult.tab) {
    throw new Error(
      `capture browser session failed to create tab: ${
        newTabResult.error ? `${newTabResult.error.code}: ${newTabResult.error.message}` : "no_tab"
      }`,
    );
  }
  const tabId = newTabResult.tab.tabId;

  const active: ActiveCapture = {
    captureId,
    sessionId,
    startedAtIso: new Date(now()).toISOString(),
    events: [],
    // newTab 返回的初始 URL（about:blank/初始页）作为 diff 基线：从这里导航出去才算 navigate。
    lastUrl: newTabResult.tab.url || null,
    eventOverflowWarned: false,
  };

  // 置为用户可见可操作；失败不致命（后台挂载仍可采集，用户可手动唤起面板）。
  const activated = await dispatch({ method: "activateTab", tabId });
  if (!activated.ok) {
    deps.logger?.warn(
      `[automation-capture] activate tab=${tabId} failed: ${activated.error?.code}`,
    );
  }
  const visible = await dispatch({ method: "browserVisibilitySet", visible: true });
  if (!visible.ok) {
    deps.logger?.warn(`[automation-capture] set browser visible failed: ${visible.error?.code}`);
  }

  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollInFlight: Promise<void> = Promise.resolve();

  /** drain 一次并合并事件；stopped 后拒绝追加（stop 的最终 drain 以 force 跳过守卫）。 */
  const drainOnce = async (force = false): Promise<void> => {
    if (stopped && !force) return;
    const result = await dispatch({ method: "evaluate", expression: drainExpression, tabId });
    if (!result.ok) {
      // 导航过程中文档销毁等瞬态失败：只告警，下轮重试（脚本自安装）。
      deps.logger?.warn(`[automation-capture] drain failed: ${result.error?.code}`);
      return;
    }
    const drained = parseAutomationCaptureDrainResult(result.value);
    if (stopped && !force) return;
    if (drained.url !== active.lastUrl) {
      // URL 变化兜底（SPA pushState/地址栏导航）：补一条 navigate 事件。drain 携带
      // 新文档事件时取首事件时间-1，保证 navigate 排在新页面事件之前。
      const firstTs = drained.events[0]?.ts;
      const navTs = firstTs !== undefined ? Math.max(0, firstTs - 1) : now();
      active.events.push({ type: "navigate", ts: navTs, url: drained.url });
      active.lastUrl = drained.url;
    }
    for (const event of drained.events) {
      if (active.events.length >= SESSION_EVENT_LIMIT) {
        if (!active.eventOverflowWarned) {
          active.eventOverflowWarned = true;
          deps.logger?.warn(
            `[automation-capture] session event limit ${SESSION_EVENT_LIMIT} reached; dropping new events`,
          );
        }
        return;
      }
      active.events.push(event);
    }
  };

  const schedulePoll = (): void => {
    pollTimer = setTimeout(() => {
      pollInFlight = drainOnce()
        .catch((error: unknown) => {
          // 单轮失败不终止采集（页面可能正在导航）；持续失败由用户停止/取消收口。
          deps.logger?.warn(
            `[automation-capture] poll error: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          if (!stopped) schedulePoll();
        });
    }, pollIntervalMs);
  };

  /** 释放 scope：可见性复位 + close 全部 tabs；尽力而为，失败只告警。 */
  const release = async (): Promise<void> => {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    try {
      await pollInFlight.catch(() => undefined);
      const hidden = await dispatch({ method: "browserVisibilitySet", visible: false });
      if (!hidden.ok) {
        deps.logger?.warn(`[automation-capture] reset visibility failed: ${hidden.error?.code}`);
      }
      const listed = await dispatch({ method: "list" });
      const tabs = listed.ok ? (listed.tabs ?? []) : [];
      for (const tab of tabs) {
        const closed = await dispatch({ method: "close", tabId: tab.tabId });
        if (!closed.ok) {
          deps.logger?.warn(
            `[automation-capture] close tab=${tab.tabId} failed: ${closed.error?.code ?? "unknown_error"}`,
          );
        }
      }
    } catch (error) {
      deps.logger?.warn(
        `[automation-capture] release failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  schedulePoll();
  // 首次 drain 安装脚本：失败不致命，轮询下一拍自愈。
  await drainOnce().catch((error: unknown) => {
    deps.logger?.warn(
      `[automation-capture] initial drain failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  deps.logger?.info(
    `[automation-capture] started capture=${captureId} session=${sessionId} tab=${tabId}`,
  );

  return {
    captureId,
    sessionId,
    state(): AutomationRecordingCaptureState {
      return {
        captureId,
        sessionId,
        startedAt: active.startedAtIso,
        lastUrl: active.lastUrl,
        stepCount: mapCaptureEventsToSteps(active.events, deps.mapping).length,
        eventCount: active.events.length,
      };
    },
    async stop(): Promise<AutomationRecordingStep[]> {
      if (stopped) return mapCaptureEventsToSteps(active.events, deps.mapping);
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      // 最终 drain 尽力而为：失败不丢已采集内容，只少最后一段。
      await pollInFlight.catch(() => undefined);
      await drainOnce(true).catch(() => undefined);
      const steps = mapCaptureEventsToSteps(active.events, deps.mapping);
      await release();
      deps.logger?.info(
        `[automation-capture] stopped capture=${captureId} steps=${steps.length} events=${active.events.length}`,
      );
      return steps;
    },
    async cancel(): Promise<void> {
      await release();
      deps.logger?.info(`[automation-capture] cancelled capture=${captureId}`);
    },
  };
}
