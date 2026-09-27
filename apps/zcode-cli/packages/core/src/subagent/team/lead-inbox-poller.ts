// ============================================================
// Agent Teams - lead inbox poller
// ============================================================
//
// specs/agent-teams.md: lead 的收件箱（inboxes/team_lead.json）由本消费循环
// 读取：首个 teammate spawn 时启动，TeamFile 被删后自停；消费产物经父任务
// 通知队列回灌 lead turn。mailbox 是消息事实源，本循环不建第二个事实源。
import type { Logger, TraceContext } from "@zcode/contracts";
import { readTeamInbox, type TeamMailboxMessage } from "./team-mailbox.js";
import { loadTeamFile, type TeamStoreDeps } from "./team-store.js";
import type { TeamWorkspaceDirs } from "./team-paths.js";

/** lead 收件箱轮询间隔（与 teammate 轮询同规格，spec：1s）。 */
export const LEAD_INBOX_POLL_INTERVAL_MS = 1_000;

export interface LeadInboxPollerInput {
  deps: TeamStoreDeps;
  dirs: TeamWorkspaceDirs;
  teamName: string;
  /** lead 成员名（contracts TEAM_LEAD_MEMBER_NAME）。 */
  leadName: string;
  /** 父通知入队：originMeta.backgroundSource 取 subagent 展示族。 */
  enqueue: (notification: {
    originMeta: { backgroundSource: "subagent"; title: string; workId: string };
    taskId: string;
    text: string;
    traceContext: TraceContext;
  }) => undefined;
  /** 通知续链的基准 trace：消息未带 traceContext 时兜底。 */
  baseTraceContext: TraceContext;
  logger?: Logger;
  /** 终止信号：lead 会话 teardown / TeamDelete 停止轮询。 */
  signal: AbortSignal;
  /** 轮询间隔注入点：生产默认 1s，测试缩短。 */
  pollIntervalMs?: number;
}

export interface LeadInboxPollerHandle {
  done: Promise<void>;
}

export function runLeadInboxPoller(input: LeadInboxPollerInput): LeadInboxPollerHandle {
  const done = pollLoop(input).catch((error) => {
    input.logger?.warn("Lead inbox poller crashed", {
      event: "agent-teams.lead_poller.crashed",
      module: "core.agent-teams",
      teamName: input.teamName,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return { done };
}

async function pollLoop(input: LeadInboxPollerInput): Promise<void> {
  const pollMs = input.pollIntervalMs ?? LEAD_INBOX_POLL_INTERVAL_MS;
  while (!input.signal.aborted) {
    // TeamFile 是团队存活事实：被 TeamDelete/会话清理删除后消费循环自停，不为已解散团队空转。
    const team = await loadTeamFile(input.deps, input.teamName);
    if (team === undefined) return;
    const { newlyRead } = await readTeamInbox(input.dirs, input.teamName, input.leadName, {
      markRead: true,
    });
    for (const message of newlyRead) {
      enqueueLeadNotification(input, message);
    }
    await sleep(pollMs);
  }
}

/** 单条邮箱消息转通知并入队；单条失败不阻断其余消息。 */
function enqueueLeadNotification(input: LeadInboxPollerInput, message: TeamMailboxMessage): void {
  try {
    const text = formatLeadInboxNotification(input.teamName, message);
    input.enqueue({
      originMeta: {
        backgroundSource: "subagent",
        title: "Team " + input.teamName + " · " + message.from,
        workId: message.id,
      },
      taskId: "team:" + input.teamName,
      text,
      traceContext: message.traceContext ?? input.baseTraceContext,
    });
  } catch (error) {
    input.logger?.warn("Failed to enqueue lead inbox notification", {
      event: "agent-teams.lead_poller.enqueue_failed",
      module: "core.agent-teams",
      teamName: input.teamName,
      messageId: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 通知正文：纯文本行格式（[Team x] from: ...），模型可读且无转义负担。
 */
export function formatLeadInboxNotification(
  teamName: string,
  message: TeamMailboxMessage,
): string {
  const from = message.from;
  const prefix = "[Team " + teamName + "] ";
  switch (message.payload.kind) {
    case "text": {
      const summarySuffix = message.summary ? " (" + message.summary + ")" : "";
      return prefix + from + ": " + message.payload.text + summarySuffix;
    }
    case "idle_notification": {
      const idleReason = message.payload.idleReason ?? "available";
      return prefix + from + " is now idle (" + idleReason + ") and awaiting messages.";
    }
    case "shutdown_response": {
      const verdict = message.payload.approve ? "approved" : "rejected";
      return prefix + from + " " + verdict + " the shutdown request.";
    }
    case "task_notification": {
      const task = message.payload;
      if (task.status === "completed") {
        return prefix + from + " completed task \"" + task.subject + "\" (" + task.taskId + ").";
      }
      if (task.status === "cancelled") {
        return prefix + from + " cancelled task \"" + task.subject + "\" (" + task.taskId + ").";
      }
      if (task.status === "pending") {
        return prefix + from + " returned task \"" + task.subject + "\" (" + task.taskId + ") to the pool.";
      }
      return prefix + from + " reopened task \"" + task.subject + "\" (" + task.taskId + ") for rework.";
    }
    case "plan_approval_request":
    case "plan_approval_response": {
      return (
        prefix +
        from +
        " sent a plan approval payload (not consumed by mailbox in v1)."
      );
    }
    default:
      return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
