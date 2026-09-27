// ============================================================
// Agent Teams - teammate 常驻监督循环（邮箱轮询 + turn 恢复 + 关停）
// ============================================================
//
// specs/agent-teams.md：teammate 空闲待命不退出；消息到达注入新对话轮；
// shutdown_request 使其优雅退出并从 roster 移除。首个 turn 由 runner 的后台
// 管线执行；本模块只负责「终态后回到空闲 → 轮询 → 恢复下一轮」的生命周期，
// 复用 runner 既有的 resume 管线（resumeTerminalAgentInBackground 语义）。
//
// 事件顺序（单一事实源：registry 状态 + TeamFile 成员表）：
//   turn running ──完成──▶ terminal(注册表) ──监督循环置 isActive=false──▶ 轮询邮箱
//      ▲                                                │ text 消息
//      └──────────resumeTurn（isActive=true）◀──────────┘
//   shutdown_request ──▶ onShutdown（清理）──▶ removeTeamMember ──▶ 循环退出
//   active→idle 翻转 ──▶ idle_notification 写 lead 收件箱（防 lead 盲等，cc-haha 对齐）
//   shutdown 生效 ──▶ shutdown_response 回执 lead 收件箱（lead 据此确认关停结果）

import type { Logger } from "@zcode/contracts";
import {
  appendTeamInboxMessage,
  buildTeamMailboxMessage,
  readTeamInbox,
  type TeamIdleReason,
  type TeamMailboxMessage,
} from "./team-mailbox.js";
import { removeTeamMember, setTeamMemberActive, type TeamStoreDeps } from "./team-store.js";
import type { TeamWorkspaceDirs } from "./team-paths.js";

/** 邮箱轮询间隔（spec：轮询间隔 1s）。 */
export const TEAMMATE_MAILBOX_POLL_INTERVAL_MS = 1_000;
/** registry 终态探测间隔：turn 运行期间更密集地观察，保证 isActive 及时翻转。 */
export const TEAMMATE_ACTIVE_PROBE_INTERVAL_MS = 500;

export interface TeammateSupervisorInput {
  deps: TeamStoreDeps;
  dirs: TeamWorkspaceDirs;
  teamName: string;
  teammateName: string;
  /**
   * lead 在 TeamFile.members 中的成员名（contracts `TEAM_LEAD_MEMBER_NAME`）。
   * idle 通知与 shutdown 回执写入该收件箱；lead 侧由 lead-inbox-poller 消费。
   */
  leadName: string;
  logger?: Logger;
  /** 仅用于日志关联。 */
  agentId: string;
  signal: AbortSignal;
  /** registry 里本 teammate 的当前任务是否已终态（completed/failed/…）。 */
  isTaskTerminal(): boolean;
  /**
   * 以一条邮箱消息恢复新一轮 turn（runner 的 resume 管线）。resolve 代表会话已启动，
   * turn 完成与否由 registry 终态表达，监督循环据此回到空闲。
   */
  resumeTurn(message: TeamMailboxMessage): Promise<void>;
  /** shutdown 生效时的额外清理（registry 终态化等）；成员移除由本模块负责。 */
  onShutdown(): Promise<void>;
  /** 轮询/探测间隔注入点：生产用默认常量，测试缩短等待。 */
  pollIntervalMs?: number;
  activeProbeIntervalMs?: number;
  /**
   * 自动认领注入点（P1）：空闲时（任务终态）调用，认领到无主 ready 任务则返回恢复消息；
   * undefined = 没有可认领任务，照常进入空闲通知。生产由 runner 绑定 claimNextReadyTask，测试可注入桩。
   */
  autoClaimTask?: () => Promise<TeamMailboxMessage | undefined>;
  /**
   * 孤儿任务防护（P3 修复）：成员被中止（TaskStop/中止信号）时释放其未完成任务回任务池。
   * 生产由 runner 绑定 releaseMemberTasks；缺省不释放。
   */
  releaseTasks?: () => Promise<void>;
  /**
   * 关停审批注入点（v2.6）：缺省自动同意（TeamDelete 为 lead 权威语义）；
   * 未来接 UI 审批时注入，返回 false 即拒绝（回执 reject，成员继续运行）。
   */
  onShutdownRequest?: () => Promise<boolean>;
}

export interface TeammateSupervisorHandle {
  /** 等待循环退出（测试与关停同步用）；spawn 路径不 await。 */
  done: Promise<void>;
}

/**
 * 运行 teammate 监督循环。本模块不落盘第二个事实源：
 * 成员活跃状态写 TeamFile（isActive），消息事实在 mailbox，任务状态在 registry。
 */
export function runTeammateSupervisor(input: TeammateSupervisorInput): TeammateSupervisorHandle {
  const done = supervise(input, { lastActive: undefined }).catch((error) => {
    input.logger?.warn("Teammate supervisor crashed", {
      event: "agent-teams.supervisor.crashed",
      module: "core.agent-teams",
      agentId: input.agentId,
      teamName: input.teamName,
      teammateName: input.teammateName,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return { done };
}

async function supervise(
  input: TeammateSupervisorInput,
  state: { lastActive: boolean | undefined },
): Promise<void> {
  const { signal } = input;
  const probeMs = input.activeProbeIntervalMs ?? TEAMMATE_ACTIVE_PROBE_INTERVAL_MS;
  const pollMs = input.pollIntervalMs ?? TEAMMATE_MAILBOX_POLL_INTERVAL_MS;
  while (!signal.aborted) {
    const terminal = input.isTaskTerminal();

    // 自动认领（P1）:空闲时先尝试认领;成功则立即开工(不发 idle 通知——马上又干活,通知无意义)。
    if (terminal && input.autoClaimTask !== undefined) {
      const claimedMessage = await input.autoClaimTask();
      if (claimedMessage !== undefined) {
        await syncActiveState(input, state, true);
        await input.resumeTurn(claimedMessage);
        continue;
      }
    }

    await syncActiveState(input, state, !terminal);
    if (!terminal) {
      await sleep(probeMs);
      continue;
    }

    // 修复依据（specs/agent-teams.md 投递语义「至多一次 + 确认读」）：readTeamInbox
    // 返回的 messages 是「已消费视角」（全部 read=true），若按它消费，turn 结束后的
    // 下一轮终态探测会把历史消息再次 resume（双重 resume 根因）。按 newlyRead 只
    // 消费「本次轮询前未读」的消息，历史已读不再重放。
    const { newlyRead } = await readTeamInbox(input.dirs, input.teamName, input.teammateName, {
      markRead: true,
    });
    const shutdown = newlyRead.find(
      (message): message is TeamMailboxMessage & { payload: { kind: "shutdown_request"; reason?: string } } =>
        message.payload.kind === "shutdown_request",
    );
    if (shutdown) {
      // 关停审批注入点（v2.6）：缺省自动同意（TeamDelete 为 lead 权威语义，spec 已修正描述）；
      // 未来接 UI 审批时注入返回 false 即拒绝（回执 reject，成员继续运行）。
      const approved = input.onShutdownRequest ? await input.onShutdownRequest() : true;
      if (!approved) {
        await notifyLead(input, {
          kind: "shutdown_response",
          approve: false,
          ...(shutdown.payload.reason === undefined ? {} : { reason: shutdown.payload.reason }),
        });
        await sleep(pollMs);
        continue;
      }
      await input.onShutdown();
      // 关停回执（specs/agent-teams.md AC5 闭环）：teammate 批准后向 lead 收件箱回
      // shutdown_response，lead 消费循环将其转为通知，lead agent 由此确认关停结果。
      await notifyLead(input, {
        kind: "shutdown_response",
        approve: true,
        ...(shutdown.payload.reason === undefined ? {} : { reason: shutdown.payload.reason }),
      });
      await removeTeamMember(input.deps, input.teamName, input.teammateName);
      input.logger?.info("Teammate shut down via shutdown_request", {
        event: "agent-teams.teammate.shutdown",
        module: "core.agent-teams",
        agentId: input.agentId,
        teamName: input.teamName,
        teammateName: input.teammateName,
      });
      return;
    }
    const nextTurn = newlyRead.find((message) => message.payload.kind === "text");
    if (nextTurn) {
      // plan_approval_request/response 载荷在此被显式跳过：v1 计划审批走 UI bridge
      // 同步链路（AC4），监督循环只消费 text；邮箱配对留给 v2 非 in-process 后端。
      // 恢复新一轮：resumeTurn resolve 即会话已启动，完成状态交给下一轮探测。
      await syncActiveState(input, state, true);
      await input.resumeTurn(nextTurn);
      continue;
    }
    await sleep(pollMs);
  }
  // signal abort（TeamDelete/会话终止）：不读邮箱，直接摘除成员记录；释放其未完成任务
  // 回任务池（P3 修复：防孤儿任务卡 in_progress——如 TaskStop 停掉单个成员时，团队与任务板仍存活）。
  if (input.releaseTasks !== undefined) {
    try {
      await input.releaseTasks();
    } catch {
      // 释放失败不阻断成员摘除（成员摘除是 TeamDelete/清理语义的硬要求）。
    }
  }
  await removeTeamMember(input.deps, input.teamName, input.teammateName);
}

/** 活跃状态防抖：只在翻转时写 TeamFile，避免每 500ms 一次无意义写盘。 */
async function syncActiveState(
  input: TeammateSupervisorInput,
  state: { lastActive: boolean | undefined },
  active: boolean,
): Promise<void> {
  if (state.lastActive === active) return;
  // idle 通知只在「确实完成过一轮 turn」时发（true→false 翻转）：首次置位
  // （undefined→x）与同值重复不通知，避免 spawn 噪声与轮询期重发。
  const flippedToIdle = state.lastActive === true && active === false;
  state.lastActive = active;
  try {
    await setTeamMemberActive(input.deps, input.teamName, input.teammateName, active);
    if (flippedToIdle) {
      await notifyLead(input, { kind: "idle_notification", idleReason: "available" });
    }
  } catch (error) {
    input.logger?.warn("Failed to persist teammate active state", {
      event: "agent-teams.teammate.active_write_failed",
      module: "core.agent-teams",
      agentId: input.agentId,
      teamName: input.teamName,
      teammateName: input.teammateName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 写 lead 收件箱（best-effort）：idle 通知与 shutdown 回执的唯一生产入口。
 * 失败只告警不阻断监督循环——通知投递失败不代表 teammate 本身故障，
 * 若向上抛错会把「通知失败」升级成「teammate 罢工」，违反空闲待命语义。
 */
async function notifyLead(
  input: TeammateSupervisorInput,
  payload:
    | { kind: "shutdown_response"; approve: boolean; reason?: string }
    | { kind: "idle_notification"; idleReason?: TeamIdleReason },
): Promise<void> {
  try {
    await appendTeamInboxMessage(
      input.deps.dirs,
      input.teamName,
      input.leadName,
      buildTeamMailboxMessage({
        from: input.teammateName,
        to: input.leadName,
        payload,
      }),
    );
  } catch (error) {
    input.logger?.warn("Failed to notify lead via team mailbox", {
      event: "agent-teams.teammate.lead_notify_failed",
      module: "core.agent-teams",
      agentId: input.agentId,
      teamName: input.teamName,
      teammateName: input.teammateName,
      payloadKind: payload.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
