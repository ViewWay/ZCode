// ============================================================
// Agent Teams - 共享任务列表工具契约（TaskCreate/TaskUpdate/TaskGet/TaskList）
// ============================================================
//
// 团队内所有成员可读写的任务集合，存储于 <team-dir>/tasks.json。
// 与个人 TodoWrite（会话私有）严格区分：共享任务带 owner，认领即写 owner，
// 更新以版本号 CAS 防双领。状态机：pending → in_progress → completed | cancelled，
// 只允许按序迁移。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const TASK_CREATE_TOOL_NAME = "TaskCreate";
export const TASK_UPDATE_TOOL_NAME = "TaskUpdate";
export const TASK_GET_TOOL_NAME = "TaskGet";
export const TASK_LIST_TOOL_NAME = "TaskList";

export const TEAM_TASK_SUBJECT_MAX_CHARS = 200;
export const TEAM_TASK_DESCRIPTION_MAX_CHARS = 4_000;

/** 共享任务状态机；迁移合法性由 isTeamTaskStatusTransition 统一判定。 */
export const TEAM_TASK_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type TeamTaskStatus = (typeof TEAM_TASK_STATUSES)[number];

/** 只允许按序迁移；回退（任何 status → pending / in_progress）必须伴随显式 owner 变更。 */
const FORWARD_TRANSITIONS: Record<TeamTaskStatus, readonly TeamTaskStatus[]> = {
  pending: ["in_progress", "completed", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export function isTeamTaskStatusTransition(from: TeamTaskStatus, to: TeamTaskStatus): boolean {
  if (from === to) return true;
  return FORWARD_TRANSITIONS[from].includes(to);
}

export const teamTaskStatusSchema = z.enum(TEAM_TASK_STATUSES);

export const TeamTaskSchema = z.object({
  taskId: z.string(),
  subject: z.string(),
  description: z.string().optional(),
  status: teamTaskStatusSchema,
  /** 认领成员名（TeamFile.members[].name）；pending 无 owner。 */
  owner: z.string().optional(),
  /** CAS 版本号：每次成功更新 +1；冲突返回明确错误，调用方重读后重试。 */
  version: z.number().int().nonnegative(),
  /** 任务依赖（P1）：taskId 列表，全部 completed 才 ready；缺失的依赖任务视为不满足。 */
  blockedBy: z.array(z.string().min(1).max(128)).optional(),
  /** 正反馈计数（P1）：owner 变更或终态重开时 +1，供 lead 派发参考；客观计数，无主观评分。 */
  attempts: z.number().int().nonnegative().optional(),
  /** 最近一次 owner 变更时间。 */
  reassignedAt: z.string().optional(),
  /** 验收结果(P3 质量门轻量):approved=验收通过;rework=需返工。 */
  reviewStatus: z.enum(["approved", "rework"]).optional(),
  /** 验收意见;revise 时必填,并作为消息送达 owner 收件箱。 */
  reviewComment: z.string().max(2_000).optional(),
  /** 验收人身份。 */
  reviewedBy: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TeamTask = z.infer<typeof TeamTaskSchema>;

export const TeamTaskListFileSchema = z.object({
  /** 团队名绑定：防止 tasks.json 被误挪到其它团队目录后被当作同一份事实。 */
  teamName: z.string(),
  tasks: z.array(TeamTaskSchema),
});
export type TeamTaskListFile = z.infer<typeof TeamTaskListFileSchema>;

export const TeamTaskConflictErrorCode = "team_task_conflict" as const;

const TEAM_TASK_ID_SCHEMA = z.string().min(1).max(128);

export const TaskCreateInputSchema = z
  .object({
    subject: z.string().min(1).max(TEAM_TASK_SUBJECT_MAX_CHARS),
    description: z.string().max(TEAM_TASK_DESCRIPTION_MAX_CHARS).optional(),
    /** 任务依赖：taskId 列表，全部 completed 后任务才可认领/开始。 */
    blockedBy: z.array(z.string().min(1).max(128)).optional(),
  })
  .strict();
export type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>;

export const TaskCreateOutputSchema = z.object({ task: TeamTaskSchema }).strict();
export type TaskCreateOutput = z.infer<typeof TaskCreateOutputSchema>;

export const TaskUpdateInputSchema = z
  .object({
    taskId: TEAM_TASK_ID_SCHEMA,
    status: teamTaskStatusSchema.optional(),
    /** 认领或转移任务；pending 任务被认领时自动迁移到 in_progress。 */
    owner: z.string().optional(),
    subject: z.string().min(1).max(TEAM_TASK_SUBJECT_MAX_CHARS).optional(),
    description: z.string().max(TEAM_TASK_DESCRIPTION_MAX_CHARS).optional(),
    /** 乐观锁：调用方读到的 version；不匹配返回 team_task_conflict。 */
    expectedVersion: z.number().int().nonnegative().optional(),
    /** 验收判定(P3):仅适用于 status=completed 的任务。approve=通过;revise=返工(自动回退 in_progress)。 */
    reviewVerdict: z.enum(["approve", "revise"]).optional(),
    /** 验收意见;revise 时必填,并作为消息送达 owner 收件箱。 */
    reviewComment: z.string().max(2_000).optional(),
  })
  .strict();
export type TaskUpdateInput = z.infer<typeof TaskUpdateInputSchema>;

export const TaskUpdateOutputSchema = z
  .object({
    task: TeamTaskSchema.optional(),
    error: z.string().optional(),
    errorCode: z.string().optional(),
  })
  .strict();
export type TaskUpdateOutput = z.infer<typeof TaskUpdateOutputSchema>;

export const TaskGetInputSchema = z.object({ taskId: TEAM_TASK_ID_SCHEMA }).strict();
export type TaskGetInput = z.infer<typeof TaskGetInputSchema>;

export const TaskGetOutputSchema = z
  .object({
    task: TeamTaskSchema.optional(),
    error: z.string().optional(),
  })
  .strict();
export type TaskGetOutput = z.infer<typeof TaskGetOutputSchema>;

export const TaskListInputSchema = z.object({}).strict();
export type TaskListInput = z.infer<typeof TaskListInputSchema>;

export const TaskListOutputSchema = z.object({ tasks: z.array(TeamTaskSchema) }).strict();
export type TaskListOutput = z.infer<typeof TaskListOutputSchema>;

function toToolSchemas() {
  return {
    TaskCreateInputJsonSchema: toToolJsonSchema(TaskCreateInputSchema),
    TaskCreateOutputJsonSchema: toToolJsonSchema(TaskCreateOutputSchema),
    TaskUpdateInputJsonSchema: toToolJsonSchema(TaskUpdateInputSchema),
    TaskUpdateOutputJsonSchema: toToolJsonSchema(TaskUpdateOutputSchema),
    TaskGetInputJsonSchema: toToolJsonSchema(TaskGetInputSchema),
    TaskGetOutputJsonSchema: toToolJsonSchema(TaskGetOutputSchema),
    TaskListInputJsonSchema: toToolJsonSchema(TaskListInputSchema),
    TaskListOutputJsonSchema: toToolJsonSchema(TaskListOutputSchema),
  } as const;
}

export const TEAM_TASK_TOOL_JSON_SCHEMAS = toToolSchemas();
export type TeamTaskToolJsonSchemas = typeof TEAM_TASK_TOOL_JSON_SCHEMAS;
