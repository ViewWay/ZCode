// ============================================================
// Team Task List Tool Handlers（TaskCreate / TaskUpdate / TaskGet / TaskList）
// ============================================================
//
// specs/agent-teams.md 共享任务列表：团队内所有成员可读写，与个人 TodoWrite 严格区分。
// 团队解析见 resolveSingleTeamName（v1：workspace 恰一个团队）；写入所有权归 runtime。

import {
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TEAM_TASK_TOOL_JSON_SCHEMAS,
  TaskCreateInputSchema,
  TaskCreateOutputSchema,
  TaskGetInputSchema,
  TaskGetOutputSchema,
  TaskListInputSchema,
  TaskListOutputSchema,
  TaskUpdateInputSchema,
  TaskUpdateOutputSchema,
  type TaskCreateInput,
  type TaskGetInput,
  type TaskListInput,
  type TaskUpdateInput,
  TEAM_LEAD_MEMBER_NAME,
  type ToolPermissionPatternSource,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { resolveTeamWorkspaceDirs } from "../../subagent/team/team-paths.js";
import { resolveSingleTeamName, TeamStoreError } from "../../subagent/team/team-store.js";
import { appendTeamInboxMessage } from "../../subagent/team/team-mailbox.js";
import {
  createTeamTask,
  getTeamTask,
  listTeamTasks,
  updateTeamTask,
} from "../../subagent/team/team-tasks.js";

const MAX_TEAM_TASK_MODEL_BYTES = 16_384;
const TEAM_TASK_TIMEOUT_MS = 10_000;

function resolveTaskToolDirs(context: Parameters<ToolHandler>[1]) {
  return resolveTeamWorkspaceDirs({
    workspaceIdentity: context.workspaceIdentity,
    workspacePath: context.workspaceRoot || context.workingDirectory,
  });
}

/** 团队级存储错误 → 可预期的业务失败（executor 按失败结果呈现，不冒泡成崩溃）。 */
function toTeamTaskFailure(error: unknown): { result: false; errorCode: number; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  // 业务错误码沿用 executor 的 ToolHandlerFailure 形态；分组号 3xx 归 agent-teams。
  return { result: false, errorCode: 3001, message };
}

const taskCreateHandler: ToolHandler = async (input, context) => {
  try {
    const parsed = TaskCreateInputSchema.parse(input) as TaskCreateInput;
    const dirs = resolveTaskToolDirs(context);
    const teamName = await resolveSingleTeamName({ dirs });
    return await createTeamTask({ dirs }, teamName, parsed);
  } catch (error) {
    if (error instanceof TeamStoreError) return toTeamTaskFailure(error);
    throw error;
  }
};

const taskUpdateHandler: ToolHandler = async (input, context) => {
  try {
    const parsed = TaskUpdateInputSchema.parse(input) as TaskUpdateInput;
    const dirs = resolveTaskToolDirs(context);
    const teamName = await resolveSingleTeamName({ dirs });
    // 正反馈闭环（specs/agent-teams.md v2.1）：任务状态迁到 completed/cancelled/重开时向 lead
    // 收件箱投递 task_notification；发送方按会话身份解析（teammate=成员名，主会话=team_lead）。
    return await updateTeamTask({ dirs }, teamName, parsed, {
      actor: context.teamMemberIdentity?.memberName,
      notifyStatusChange: (message) =>
        appendTeamInboxMessage(dirs, teamName, TEAM_LEAD_MEMBER_NAME, message),
      notifyMember: (memberName, message) =>
        appendTeamInboxMessage(dirs, teamName, memberName, message),
    });
  } catch (error) {
    if (error instanceof TeamStoreError) return toTeamTaskFailure(error);
    throw error;
  }
};

const taskGetHandler: ToolHandler = async (input, context) => {
  try {
    const parsed = TaskGetInputSchema.parse(input) as TaskGetInput;
    const dirs = resolveTaskToolDirs(context);
    const teamName = await resolveSingleTeamName({ dirs });
    return await getTeamTask({ dirs }, teamName, parsed);
  } catch (error) {
    if (error instanceof TeamStoreError) return toTeamTaskFailure(error);
    throw error;
  }
};

const taskListHandler: ToolHandler = async (input, context) => {
  try {
    TaskListInputSchema.parse(input as TaskListInput);
    const dirs = resolveTaskToolDirs(context);
    const teamName = await resolveSingleTeamName({ dirs });
    return await listTeamTasks({ dirs }, teamName);
  } catch (error) {
    if (error instanceof TeamStoreError) return toTeamTaskFailure(error);
    throw error;
  }
};

// -----------------------------------------------
// Model-facing content
// -----------------------------------------------

function formatTaskCreateModelContent(output: unknown): string {
  const result = TaskCreateOutputSchema.parse(output);
  return `Task ${result.task.taskId} created: "${result.task.subject}" (${result.task.status}).`;
}

function formatTaskUpdateModelContent(output: unknown): string {
  const result = TaskUpdateOutputSchema.parse(output);
  if (result.error) return `TaskUpdate failed: ${result.error}`;
  const task = result.task!;
  const owner = task.owner ? `, owner ${task.owner}` : "";
  return `Task ${task.taskId} updated: "${task.subject}" → ${task.status}${owner} (v${task.version}).`;
}

function formatTaskGetModelContent(output: unknown): string {
  const result = TaskGetOutputSchema.parse(output);
  if (result.error) return `TaskGet failed: ${result.error}`;
  const task = result.task!;
  return [
    `Task ${task.taskId}: "${task.subject}"`,
    `status: ${task.status}${task.owner ? `, owner: ${task.owner}` : ""} (v${task.version})`,
    ...(task.description === undefined ? [] : [`description: ${task.description}`]),
  ].join("\n");
}

function formatTaskListModelContent(output: unknown): string {
  const result = TaskListOutputSchema.parse(output);
  if (result.tasks.length === 0) return "No shared tasks yet. Create one with TaskCreate.";
  return result.tasks
    .map((task) => {
      const owner = task.owner ? ` · ${task.owner}` : "";
      return `- [${task.status}] ${task.subject}${owner} (${task.taskId} v${task.version})`;
    })
    .join("\n");
}

// -----------------------------------------------
// Tool entries（四个工具共用一套契约/预算/权限形状）
// -----------------------------------------------

const TEAM_TASK_PERMISSION = {
  permission: "team.task",
  riskLevel: "low" as const,
  sideEffectScope: "workspace" as const,
  needsApproval: false,
  patternSources: ["toolName"] as ToolPermissionPatternSource[],
  alwaysAllowPatternSources: ["toolName"] as ToolPermissionPatternSource[],
  denyPriority: "beforeAsk" as const,
};

function teamTaskToolEntry(input: {
  name: string;
  capability: string;
  description: string;
  handler: ToolHandler;
  inputSchema: (typeof TEAM_TASK_TOOL_JSON_SCHEMAS)["TaskCreateInputJsonSchema"];
  outputSchema: (typeof TEAM_TASK_TOOL_JSON_SCHEMAS)["TaskCreateOutputJsonSchema"];
  runtimeInputSchema: unknown;
  formatModelContent: (output: unknown) => string;
  readOnly: boolean;
}): ToolEntry {
  return {
    capability: input.capability,
    metadata: {
      name: input.name,
      description: input.description,
      readOnly: input.readOnly,
      destructive: false,
      concurrentSafe: true,
      timeoutMs: TEAM_TASK_TIMEOUT_MS,
      maxOutputBytes: MAX_TEAM_TASK_MODEL_BYTES,
      sideEffectScope: "workspace",
      riskLevel: "low",
      needsApproval: false,
    },
    handler: input.handler,
    formatModelContent: input.formatModelContent,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    runtimeInputSchema: input.runtimeInputSchema,
    permission: { ...TEAM_TASK_PERMISSION, reason: `${input.name} reads or writes the team shared task list` },
    resultBudget: {
      maxInlineBytes: MAX_TEAM_TASK_MODEL_BYTES,
      maxModelBytes: MAX_TEAM_TASK_MODEL_BYTES,
      strategy: "truncate",
      preview: { maxBytes: MAX_TEAM_TASK_MODEL_BYTES, direction: "head" },
    },
    timeout: { defaultMs: TEAM_TASK_TIMEOUT_MS, maxMs: TEAM_TASK_TIMEOUT_MS, allowCallOverride: false },
    cancellation: { supported: true, cleanup: "none", userVisibleMessage: `${input.name} was cancelled` },
    trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
  };
}

export const taskCreateToolEntry: ToolEntry = teamTaskToolEntry({
  name: TASK_CREATE_TOOL_NAME,
  capability: "Create a task on the team shared task list",
  description: [
    "# TaskCreate",
    "",
    "Create a task on the team shared task list. All team members see it and can claim it.",
    "",
    '```json\n{"subject": "Refactor storage layer", "description": "Split store.ts by aggregate"}\n```',
  ].join("\n"),
  handler: taskCreateHandler,
  inputSchema: TEAM_TASK_TOOL_JSON_SCHEMAS.TaskCreateInputJsonSchema,
  outputSchema: TEAM_TASK_TOOL_JSON_SCHEMAS.TaskCreateOutputJsonSchema,
  runtimeInputSchema: TaskCreateInputSchema,
  formatModelContent: formatTaskCreateModelContent,
  readOnly: false,
});

export const taskUpdateToolEntry: ToolEntry = teamTaskToolEntry({
  name: TASK_UPDATE_TOOL_NAME,
  capability: "Update or claim a task on the team shared task list (CAS by version)",
  description: [
    "# TaskUpdate",
    "",
    "Update status/owner of a shared task. Claiming by setting `owner` moves a pending task to in_progress.",
    "Pass `expectedVersion` (from TaskList/TaskGet) to avoid double-claim races; on conflict, re-read and retry.",
    "",
    '```json\n{"taskId": "task_<uuid>", "owner": "alice", "expectedVersion": 0}\n```',
  ].join("\n"),
  handler: taskUpdateHandler,
  inputSchema: TEAM_TASK_TOOL_JSON_SCHEMAS.TaskUpdateInputJsonSchema,
  outputSchema: TEAM_TASK_TOOL_JSON_SCHEMAS.TaskUpdateOutputJsonSchema,
  runtimeInputSchema: TaskUpdateInputSchema,
  formatModelContent: formatTaskUpdateModelContent,
  readOnly: false,
});

export const taskGetToolEntry: ToolEntry = teamTaskToolEntry({
  name: TASK_GET_TOOL_NAME,
  capability: "Read one task from the team shared task list",
  description: [
    "# TaskGet",
    "",
    "Read one shared task by id.",
    "",
    '```json\n{"taskId": "task_<uuid>"}\n```',
  ].join("\n"),
  handler: taskGetHandler,
  inputSchema: TEAM_TASK_TOOL_JSON_SCHEMAS.TaskGetInputJsonSchema,
  outputSchema: TEAM_TASK_TOOL_JSON_SCHEMAS.TaskGetOutputJsonSchema,
  runtimeInputSchema: TaskGetInputSchema,
  formatModelContent: formatTaskGetModelContent,
  readOnly: true,
});

export const taskListToolEntry: ToolEntry = teamTaskToolEntry({
  name: TASK_LIST_TOOL_NAME,
  capability: "List all tasks on the team shared task list",
  description: [
    "# TaskList",
    "",
    "List every task on the team shared task list with status, owner and version.",
    "",
    "```json\n{}\n```",
  ].join("\n"),
  handler: taskListHandler,
  inputSchema: TEAM_TASK_TOOL_JSON_SCHEMAS.TaskListInputJsonSchema,
  outputSchema: TEAM_TASK_TOOL_JSON_SCHEMAS.TaskListOutputJsonSchema,
  runtimeInputSchema: TaskListInputSchema,
  formatModelContent: formatTaskListModelContent,
  readOnly: true,
});
