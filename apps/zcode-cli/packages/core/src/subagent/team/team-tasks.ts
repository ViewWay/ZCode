// ============================================================
// Agent Teams - 共享任务列表（tasks.json，CAS 版本号防双领）
// ============================================================
//
// specs/agent-teams.md 共享任务列表约定：
//   - 存储 `<team-dir>/tasks.json`，写入所有权归 runtime，与 TeamFile 同级；
//   - 与个人 TodoWrite（会话私有）严格区分；任务带 owner，认领即写 owner；
//   - 更新以版本号 CAS，冲突返回明确错误（team_task_conflict）；
//   - 状态机 pending → in_progress → completed | cancelled，只允许按序迁移；
//     回退（终态 → 未完成态）必须伴随显式 owner 变更。

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  TEAM_LEAD_MEMBER_NAME,
  TEAM_TASK_STATUSES,
  TaskGetOutputSchema,
  TaskListOutputSchema,
  TaskUpdateOutputSchema,
  isTeamTaskStatusTransition,
  type TaskCreateInput,
  type TaskCreateOutput,
  type TaskGetInput,
  type TaskGetOutput,
  type TaskListInput,
  type TaskListOutput,
  type TaskUpdateInput,
  type TaskUpdateOutput,
  type TeamTask,
  type TeamTaskListFile,
  type TeamTaskStatus,
} from "@zcode/contracts";
import type { TeamWorkspaceDirs } from "./team-paths.js";
import { readTextFileSafe } from "./team-json-file.js";
import { buildTeamMailboxMessage, type TeamMailboxMessage } from "./team-mailbox.js";
import { withTeamFileLock } from "./team-lock.js";

const TASKS_ATOMIC_TMP_SUFFIX = ".tmp";
export const TEAM_TASK_CONFLICT_ERROR_CODE = "team_task_conflict";
export const TEAM_TASK_NOT_FOUND_ERROR_CODE = "team_task_not_found";

export interface TeamTasksDeps {
  dirs: TeamWorkspaceDirs;
}

// -----------------------------------------------
// 读取
// -----------------------------------------------

async function loadTaskListFile(deps: TeamTasksDeps, teamName: string): Promise<TeamTaskListFile> {
  const raw = await readTextFileSafe(deps.dirs.teamTasksFile(teamName));
  if (raw === undefined) {
    return { teamName, tasks: [] };
  }
  const parsed = JSON.parse(raw) as TeamTaskListFile;
  // teamName 绑定防止 tasks.json 被挪到别的团队目录后被当作同一份事实。
  if (parsed.teamName !== teamName || !Array.isArray(parsed.tasks)) {
    throw new Error(`Team tasks file is inconsistent with team ${teamName}`);
  }
  return parsed;
}

async function saveTaskListFile(deps: TeamTasksDeps, teamName: string, file: TeamTaskListFile): Promise<void> {
  const tasksFile = deps.dirs.teamTasksFile(teamName);
  await mkdir(dirname(tasksFile), { recursive: true });
  const tmpFile = `${tasksFile}${TASKS_ATOMIC_TMP_SUFFIX}`;
  await writeFile(tmpFile, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await rename(tmpFile, tasksFile);
}

// -----------------------------------------------
// TaskCreate
// -----------------------------------------------

export async function createTeamTask(
  deps: TeamTasksDeps,
  teamName: string,
  input: TaskCreateInput,
): Promise<TaskCreateOutput> {
  const tasksFile = deps.dirs.teamTasksFile(teamName);
  return withTeamFileLock(tasksFile, async () => {
    const file = await loadTaskListFile(deps, teamName);
    const now = new Date().toISOString();
    const task: TeamTask = {
      taskId: `task_${randomUUID()}`,
      subject: input.subject,
      status: "pending",
      version: 0,
      createdAt: now,
      updatedAt: now,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.blockedBy === undefined ? {} : { blockedBy: validateBlockedBy(input.blockedBy, file.tasks) }),
    };
    await saveTaskListFile(deps, teamName, { ...file, tasks: [...file.tasks, task] });
    return { task };
  });
}

// -----------------------------------------------
// TaskUpdate（CAS + 状态机）
// -----------------------------------------------

export interface UpdateTeamTaskOptions {
  /**
   * 状态迁移通知的投递口（handler 注入「写 lead 收件箱」实现）：任务迁到 completed/cancelled
   * 或从终态重开时投递 task_notification。缺席则不通知（存储层保持纯净，测试可注入捕获器）。
   */
  notifyStatusChange?: (message: TeamMailboxMessage) => Promise<unknown>;
  /** 验收/评审通知投递口:把消息写到目标成员(如任务 owner)的收件箱。 */
  notifyMember?: (memberName: string, message: TeamMailboxMessage) => Promise<unknown>;
  /** 通知的发送方身份；缺省视为 lead 主动操作。 */
  actor?: string;
}

export async function updateTeamTask(
  deps: TeamTasksDeps,
  teamName: string,
  input: TaskUpdateInput,
  options?: UpdateTeamTaskOptions,
): Promise<TaskUpdateOutput> {
  const tasksFile = deps.dirs.teamTasksFile(teamName);
  return withTeamFileLock(tasksFile, async () => {
    const file = await loadTaskListFile(deps, teamName);
    const index = file.tasks.findIndex((task) => task.taskId === input.taskId);
    if (index < 0) {
      return {
        error: `Task ${input.taskId} does not exist in team ${teamName}`,
        errorCode: TEAM_TASK_NOT_FOUND_ERROR_CODE,
      };
    }
    const current = file.tasks[index]!;

    // 验收-返工环(P3,specs/agent-teams.md v2.4):verdict 仅适用于 completed 任务。
    // approve=通过(记录评审,不改状态);revise=返工(自动回退 in_progress,意见以文本
    // 送达 owner 收件箱——owner 的监督循环消费文本并恢复 turn,成员由此知道改什么)。
    if (input.reviewVerdict !== undefined) {
      if (current.status !== "completed") {
        return {
          error: `Task ${input.taskId} cannot be reviewed: only completed tasks accept a review verdict`,
          errorCode: "team_task_review_requires_completed",
        };
      }
      if (input.reviewVerdict === "revise" && (input.reviewComment ?? "").trim().length === 0) {
        return {
          error: `Task ${input.taskId} revision requires reviewComment explaining what to change`,
          errorCode: "team_task_review_comment_required",
        };
      }
      const reviewer = options?.actor ?? TEAM_LEAD_MEMBER_NAME;
      const revised = input.reviewVerdict === "revise";
      const updatedAt = new Date().toISOString();
      const updated: TeamTask = {
        ...current,
        status: revised ? "in_progress" : current.status,
        version: current.version + 1,
        updatedAt,
        reviewStatus: revised ? "rework" : "approved",
        reviewComment: input.reviewComment,
        reviewedBy: reviewer,
        ...(revised ? { attempts: current.attempts === undefined ? 1 : current.attempts + 1 } : {}),
      };
      const reviewTasks = [...file.tasks];
      reviewTasks[index] = updated;
      await saveTaskListFile(deps, teamName, { ...file, tasks: reviewTasks });
      if (options?.notifyMember) {
        try {
          const ownerName = current.owner ?? TEAM_LEAD_MEMBER_NAME;
          const lines = [
            "Review on task \"" + current.subject + "\" (" + current.taskId + "): " + (revised ? "REWORK" : "APPROVED"),
          ];
          if (input.reviewComment !== undefined && input.reviewComment.length > 0) lines.push(input.reviewComment);
          if (revised) lines.push("Please revise and resubmit; set status back to \"completed\" when done.");
          await options.notifyMember(
            ownerName,
            buildTeamMailboxMessage({
              from: reviewer,
              to: ownerName,
              summary: "Review: " + (revised ? "rework" : "approved"),
              payload: { kind: "text", text: lines.join("\n") },
            }),
          );
        } catch {
          // 评审通知 best-effort:投递失败不影响已落盘的验收状态。
        }
      }
      return TaskUpdateOutputSchema.parse({ task: updated });
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      return {
        error: `Task ${input.taskId} version conflict: expected ${input.expectedVersion}, current ${current.version}`,
        errorCode: TEAM_TASK_CONFLICT_ERROR_CODE,
      };
    }

    const ownerChanged = input.owner !== undefined && input.owner !== current.owner;
    const nextOwner = input.owner !== undefined ? input.owner : current.owner;
    let nextStatus: TeamTaskStatus = input.status ?? current.status;
    // 认领 pending 任务的隐含语义：owner 出现即视为开始执行（spec：认领即写 owner）。
    if (input.owner !== undefined && current.status === "pending" && input.status === undefined) {
      nextStatus = "in_progress";
    }
    const forward = isTeamTaskStatusTransition(current.status, nextStatus);
    const terminal =
      current.status === "completed" || current.status === "cancelled"
        ? (current.status as "completed" | "cancelled")
        : undefined;
    if (!forward) {
      // 按序迁移失败分两类：普通回退（如 in_progress → pending）与终态复活。
      // spec：只允许按序迁移，回退需显式 owner 变更 —— 两类都必须伴随 owner 变更才放行。
      if (!ownerChanged) {
        return {
          error: terminal
            ? `Task ${input.taskId} is ${current.status}; reopening requires an explicit owner change`
            : `Task ${input.taskId} cannot transition from ${current.status} to ${nextStatus} without an explicit owner change`,
          errorCode: terminal ? "team_task_reopen_requires_owner" : "team_task_invalid_transition",
        };
      }
    }
    const isTerminalNext = nextStatus === "completed" || nextStatus === "cancelled";
    if (isTerminalNext && !terminal && nextOwner === undefined) {
      return {
        error: `Task ${input.taskId} cannot reach ${nextStatus} without an owner`,
        errorCode: "team_task_owner_required",
      };
    }

    // 依赖阻塞（P1):blockedBy 全部 completed 才 ready;不满足时开始/重开执行被拒。
    if (nextStatus === "in_progress" && !isTaskReady(file.tasks, current)) {
      return {
        error: `Task ${input.taskId} is blocked: not all blockedBy dependencies are completed`,
        errorCode: "team_task_blocked",
      };
    }

    // 正反馈计数(P1):owner 变更或终态重开时 attempts+1,客观记录派发轮次供 lead 参考。
    const reopenedFromTerminal = terminal !== undefined && !isTerminalNext;
    const dispatchBumped = ownerChanged || reopenedFromTerminal;
    const updatedAt = new Date().toISOString();
    const updated: TeamTask = {
      ...current,
      status: nextStatus,
      version: current.version + 1,
      updatedAt,
      ...(nextOwner === undefined ? {} : { owner: nextOwner }),
      ...(dispatchBumped ? { attempts: current.attempts === undefined ? 1 : current.attempts + 1 } : {}),
      ...(ownerChanged ? { reassignedAt: updatedAt } : {}),
    };
    const tasks = [...file.tasks];
    tasks[index] = updated;
    await saveTaskListFile(deps, teamName, { ...file, tasks });

    // 正反馈闭环（specs/agent-teams.md v2.1）：任务迁到 completed/cancelled 或从终态重开时，
    // 向 lead 收件箱投递 task_notification——lead 对成员完成情况从此有一等信号，
    // 派发决策不必轮询 TaskList。认领/进行中不通知，避免噪声。
    if (
      options?.notifyStatusChange &&
      nextStatus !== current.status &&
      isNotifiableTaskTransition(current.status, nextStatus)
    ) {
      const actor = options.actor ?? TEAM_LEAD_MEMBER_NAME;
      try {
        await options.notifyStatusChange(
          buildTeamMailboxMessage({
            from: actor,
            to: TEAM_LEAD_MEMBER_NAME,
            payload: {
              kind: "task_notification",
              taskId: updated.taskId,
              subject: updated.subject,
              status: nextStatus,
              actor,
            },
          }),
        );
      } catch {
        // 通知是增强信号：投递失败不能回滚已落盘的状态迁移，也不能让工具调用报错
        // （成员的实际工作已完成）。可观测性由 TaskList 与 roster 兜底。
      }
    }
    return TaskUpdateOutputSchema.parse({ task: updated });
  });
}

// -----------------------------------------------
// TaskGet / TaskList
// -----------------------------------------------

export async function getTeamTask(
  deps: TeamTasksDeps,
  teamName: string,
  input: TaskGetInput,
): Promise<TaskGetOutput> {
  const file = await loadTaskListFile(deps, teamName);
  const task = file.tasks.find((candidate) => candidate.taskId === input.taskId);
  return TaskGetOutputSchema.parse(task ? { task } : { error: `Task ${input.taskId} not found` });
}

export async function listTeamTasks(
  deps: TeamTasksDeps,
  teamName: string,
  _input: TaskListInput = {},
): Promise<TaskListOutput> {
  const file = await loadTaskListFile(deps, teamName);
  return TaskListOutputSchema.parse({ tasks: file.tasks });
}

/**
 * 哪些状态迁移值得通知 lead（正反馈闭环的最小集合，specs/agent-teams.md v2.1）：
 * 完成、取消、以及从终态重开（返工开始）。认领/进行中不打扰 lead，避免通知噪声。
 */
export function isNotifiableTaskTransition(
  previous: TeamTaskStatus,
  next: TeamTaskStatus,
): boolean {
  if (previous === next) return false;
  if (next === "completed" || next === "cancelled") return true;
  return previous === "completed" || previous === "cancelled";
}

/**
 * blockedBy 校验（P1）：去重；引用不存在的 taskId 直接报错(坏输入不落盘)。
 */
function validateBlockedBy(blockedBy: readonly string[], tasks: readonly TeamTask[]): string[] {
  const unique = [...new Set(blockedBy)];
  const missing = unique.filter((id) => !tasks.some((task) => task.taskId === id));
  if (missing.length > 0) {
    throw new Error(`Unknown blockedBy taskId: ${missing.join(", ")}`);
  }
  return unique;
}

/**
 * 任务就绪判定（P1）：blockedBy 全部 completed 即 ready；缺失的依赖任务视为不满足。
 */
export function isTaskReady(tasks: readonly TeamTask[], task: Pick<TeamTask, "blockedBy">): boolean {
  return (task.blockedBy ?? []).every((id) => {
    const dependency = tasks.find((candidate) => candidate.taskId === id);
    return dependency?.status === "completed";
  });
}

/**
 * 自动认领（P1,dsh-agent-teams 语义):空闲 teammate 认领首个「pending、无 owner、ready」任务。
 * 竞争防护:CAS(expectedVersion)+文件锁;争抢失败者得到 undefined,保持空闲等待。
 */
export async function claimNextReadyTask(
  deps: TeamTasksDeps,
  teamName: string,
  memberName: string,
): Promise<TeamTask | undefined> {
  const file = await loadTaskListFile(deps, teamName);
  const candidate = file.tasks.find(
    (task) => task.status === "pending" && task.owner === undefined && isTaskReady(file.tasks, task),
  );
  if (candidate === undefined) return undefined;
  const result = await updateTeamTask(
    deps,
    teamName,
    {
      taskId: candidate.taskId,
      owner: memberName,
      expectedVersion: candidate.version,
    },
    { actor: memberName },
  );
  return result.task;
}

export { TEAM_TASK_STATUSES };
