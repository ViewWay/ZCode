// ============================================================
// Agent Teams - 团队关停与 AC7 会话清理（runtime 侧执行器）
// ============================================================
//
// specs/agent-teams.md：
//   - TeamDelete（AC5 完整语义）：向全部存活 teammate 投递 shutdown_request，
//     等待成员收敛（上限 30s，TEAM_SHUTDOWN_APPROVAL_TIMEOUT_MS）后强制
//     abort 残留者，最后删除团队目录（TeamFile+mailboxes+tasks）。
//   - AC7：lead 会话 teardown 时回收本会话创建的 teams 运行时与磁盘事实。
//
// 状态所有权：TeamFile/mailbox 磁盘事实源；abort 只影响内存运行时，
// 磁盘收敛（成员摘除）由各 teammate 监督循环的 abort 路径完成。

import { TEAM_SHUTDOWN_APPROVAL_TIMEOUT_MS } from "@zcode/contracts";
import { appendTeamInboxMessage, buildTeamMailboxMessage } from "./team-mailbox.js";
import { archiveTeamKnowledge } from "./team-knowledge.js";
import { deleteTeamDir, loadTeamFile } from "./team-store.js";
import type { TeamWorkspaceDirs } from "./team-paths.js";

/** runner 闭包持有的 teammate 内存句柄：abort 触发监督循环摘除成员. */
export interface TeammateRuntimeHandle {
  name: string;
  abort: () => void;
  done: Promise<void>;
}

export interface TeamShutdownRuntimeDeps {
  dirs: TeamWorkspaceDirs;
  /** 当前团队全部存活 teammate 句柄（调用方按团队过滤后提供）。 */
  listTeammates: () => readonly TeammateRuntimeHandle[];
}

export interface TeamShutdownOutcome {
  status: "deleted" | "not_found";
  /** 收到 shutdown_request 的成员数（lead 除外）。 */
  requested: number;
  /** 等待窗口内自愿退出的成员数；其余为强制终止。 */
  exited: number;
}

/** 收敛等待窗口的轮询间隔（TeamFile 成员数探测）。 */
const TEAM_SHUTDOWN_CONVERGE_POLL_MS = 250;

/**
 * TeamDelete 完整语义（AC5）：shutdown_request 投递 → 等待成员收敛 →
 * 强制 abort 残留者 → 删除团队目录。由 SubagentPort.shutdownTeam 调用。
 */
export async function shutdownTeamRuntime(
  deps: TeamShutdownRuntimeDeps,
  teamName: string,
  leadName: string,
  options?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<TeamShutdownOutcome> {
  const timeoutMs = options?.timeoutMs ?? TEAM_SHUTDOWN_APPROVAL_TIMEOUT_MS;
  const pollMs = options?.pollIntervalMs ?? TEAM_SHUTDOWN_CONVERGE_POLL_MS;
  const team = await loadTeamFile({ dirs: deps.dirs }, teamName);
  if (team === undefined) {
    return { status: "not_found", requested: 0, exited: 0 };
  }
  const handles = deps
    .listTeammates()
    .filter((candidate) => candidate.name !== leadName);
  const requested = handles.length;
  // shutdown_request 逐成员投递（文件锁互斥）；单成员失败不阻断其余（AC3 语义）。
  for (const handle of handles) {
    try {
      const message = buildTeamMailboxMessage({
        from: leadName,
        to: handle.name,
        payload: { kind: "shutdown_request", reason: "team deleted" },
      });
      await appendTeamInboxMessage(deps.dirs, teamName, handle.name, message);
    } catch {
      // 投递失败不升级为整体失败：等待窗口 + 强制收尾仍能保证目录被清理。
    }
  }
  // 等待成员收敛：TeamFile 非 lead 成员清空即收敛；窗口上限 30s（spec）。
  const deadline = Date.now() + timeoutMs;
  let exited = 0;
  while (Date.now() < deadline) {
    const current = await loadTeamFile({ dirs: deps.dirs }, teamName);
    const remaining = current
      ? current.members.filter((member) => member.name !== leadName)
      : [];
    if (remaining.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const settled = await loadTeamFile({ dirs: deps.dirs }, teamName);
  const remainingNames = new Set(
    (settled ?? team).members
      .filter((member) => member.name !== leadName)
      .map((member) => member.name),
  );
  exited = requested - remainingNames.size;
  // 窗口内未退出的成员强制终止：abort 即监督循环摘除成员路径，
  // TeamDelete 语义要求目录删除后不留活的 teammate 运行时。
  for (const handle of handles) {
    if (remainingNames.has(handle.name)) {
      handle.abort();
    }
  }
  // 知识归档(v2.5):团队解散,知识不散;归档失败不阻断删除(best-effort)。
  try {
    await archiveTeamKnowledge({ dirs: deps.dirs }, teamName);
  } catch {
    // ignore:归档失败仍按原语义删除团队目录,由调用方日志兜底。
  }
  // worktree 清理（v2.7）：成员工作分支保留（lead 合并入口），工作目录移除。
  try {
    const { cleanupTeamWorktrees } = await import("./team-worktree.js");
    await cleanupTeamWorktrees(deps.dirs.teamsRoot, teamName);
  } catch {
    // 清理失败不阻断删除（残留目录由 git worktree prune 兜底）。
  }
  const { deleted } = await deleteTeamDir({ dirs: deps.dirs }, teamName);
  return { status: deleted ? "deleted" : "not_found", requested, exited };
}

/**
 * AC7 会话清理：lead 会话 teardown 时调用。abort 全部 teammate（监督循环
 * 摘除成员）后删除团队目录；不等待审批——会话正在结束，无审批通道。
 */
export async function cleanupSessionTeamRuntime(
  deps: TeamShutdownRuntimeDeps,
  teamName: string,
): Promise<void> {
  for (const handle of deps.listTeammates()) {
    handle.abort();
  }
  // 知识归档(v2.5):会话清理同样保留知识(best-effort)。
  try {
    await archiveTeamKnowledge({ dirs: deps.dirs }, teamName);
  } catch {
    // ignore:归档失败不阻断会话清理。
  }
  // worktree 清理（v2.7）：会话清理同样移除成员工作目录（分支保留）。
  try {
    const { cleanupTeamWorktrees } = await import("./team-worktree.js");
    await cleanupTeamWorktrees(deps.dirs.teamsRoot, teamName);
  } catch {
    // ignore：清理失败不阻断会话收尾。
  }
  await deleteTeamDir({ dirs: deps.dirs }, teamName);
}
