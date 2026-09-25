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
    };
    await saveTaskListFile(deps, teamName, { ...file, tasks: [...file.tasks, task] });
    return { task };
  });
}

// -----------------------------------------------
// TaskUpdate（CAS + 状态机）
// -----------------------------------------------

export async function updateTeamTask(
  deps: TeamTasksDeps,
  teamName: string,
  input: TaskUpdateInput,
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

    const updated: TeamTask = {
      ...current,
      status: nextStatus,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      ...(nextOwner === undefined ? {} : { owner: nextOwner }),
    };
    const tasks = [...file.tasks];
    tasks[index] = updated;
    await saveTaskListFile(deps, teamName, { ...file, tasks });
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

export { TEAM_TASK_STATUSES };
