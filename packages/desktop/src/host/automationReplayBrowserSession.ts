import type { BrowserCommand, BrowserCommandResult } from "@zcode/shared";
import {
  createBrowserCommandActionExecutor,
  type BrowserActionExecutor,
} from "./automationReplayExecutors.js";

/**
 * 回放浏览器会话（specs/record-replay.md）：手动回放复用 host↔main 的受控浏览器
 * 执行链路，为每次回放构造一个 host 拥有的临时 browser scope
 * （sessionId = automation-replay:<runId>）。
 *
 * - main 侧 BrowserGuestManager 按 scope 隔离 tab；scope 内首个命令会隐式创建
 *   agent tab 并由 renderer 后台挂载 guest（不抢当前对话焦点），因此「获取会话」
 *   只需 preflight 验证 host→main 执行链路可达，不需要新增 main 侧 API。
 * - 释放 = list 出该 scope 的 tabs 逐个 close；清理尽力而为，失败只告警不抛错
 *   （报告已落盘，不能因清理失败覆盖回放结果）。
 */

/** 回放会话执行端口；与 browserControlMainBridge.execute 的（可选字段）入参结构兼容。 */
export interface AutomationReplayBrowserSessionPort {
  execute(input: {
    sessionId: string;
    workspaceKey?: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    command: BrowserCommand;
  }): Promise<BrowserCommandResult>;
}

/** 宿主 workspace 身份；缺省字段由 bridge 以 sessionId 作为 fallback（本地隔离 scope）。 */
export interface AutomationReplayBrowserSessionWorkspace {
  workspaceKey?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
}

export interface AutomationReplayBrowserSessionDeps {
  port: AutomationReplayBrowserSessionPort;
  workspace?: AutomationReplayBrowserSessionWorkspace;
  logger?: Pick<Console, "info" | "warn">;
}

export interface AutomationReplayBrowserSession {
  /** 逐步骤派发的真实执行面（BrowserCommand 适配器）。 */
  executor: BrowserActionExecutor;
  /** 回放结束/失败后释放 scope 内浏览器资源；尽力而为，不抛错。 */
  release(): Promise<void>;
}

/** sessionId 前缀：回放 scope 与 agent 会话天然隔离，报告/日志可直接对账。 */
export const AUTOMATION_REPLAY_SESSION_PREFIX = "automation-replay:";

export function buildAutomationReplaySessionId(runId: string): string {
  return `${AUTOMATION_REPLAY_SESSION_PREFIX}${runId}`;
}

/**
 * 获取回放浏览器会话：preflight 一条 list 命令验证 host→main 链路可达。
 * preflight 失败（含 bridge 抛错）时抛结构化错误，由调用方回退 unavailable
 * 执行面——绝不带着坏链路执行回放步骤（诚实失败，specs/record-replay.md）。
 */
export async function acquireAutomationReplayBrowserSession(
  deps: AutomationReplayBrowserSessionDeps,
  runId: string,
): Promise<AutomationReplayBrowserSession> {
  const sessionId = buildAutomationReplaySessionId(runId);
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

  const preflight = await dispatch({ method: "list" });
  if (!preflight.ok) {
    throw new Error(
      `replay browser session preflight failed: ${
        preflight.error ? `${preflight.error.code}: ${preflight.error.message}` : "unknown_error"
      }`,
    );
  }

  return {
    executor: createBrowserCommandActionExecutor({
      dispatcher: dispatch,
      surface: `browser-command-bridge:${AUTOMATION_REPLAY_SESSION_PREFIX}session`,
    }),
    async release(): Promise<void> {
      try {
        const listed = await dispatch({ method: "list" });
        const tabs = listed.ok ? (listed.tabs ?? []) : [];
        for (const tab of tabs) {
          const closed = await dispatch({ method: "close", tabId: tab.tabId });
          if (!closed.ok) {
            deps.logger?.warn(
              `[automation-recording] replay session close tab=${tab.tabId} failed: ${
                closed.error?.code ?? "unknown_error"
              }`,
            );
          }
        }
      } catch (error) {
        // 释放失败不影响已落盘的报告，只告警定位。
        deps.logger?.warn(
          `[automation-recording] replay session release failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  };
}
