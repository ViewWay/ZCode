// ============================================================
// TeamPlan / TeamPlanApprove Tool Handlers（v2.10 计划-审批-启动）
// ============================================================
//
// specs/agent-teams.md v2.10：TeamCreate 之后、Agent spawn 之前，lead 用 TeamPlan
// 起草并提交完整团队草案（成员 + 任务 + 依赖）；submit 后进入 review_pending，
// lead 被制度性禁止动工。批准走 TeamPlanApprove——needsApproval 的确认弹窗即
// 人类批准面（拒绝即驳回，lead 带 feedback 重新 replace/submit）；批准成功后
// launchPlan 按 v2.8 templatePlan 同构格式回灌 lead 实例化剧本。
// 注册门与 TeamCreate 同款（includeTeam：lead only）。

import {
  TEAM_PLAN_APPROVE_TOOL_NAME,
  TEAM_PLAN_TOOL_NAME,
  TeamPlanInputJsonSchema,
  TeamPlanInputSchema,
  TeamPlanOutputJsonSchema,
  TeamPlanOutputSchema,
  type TeamPlanInput,
  type TeamPlanOutput,
  type TeamPlanRecord,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { resolveTeamWorkspaceDirs } from "../../subagent/team/team-paths.js";
import { TeamStoreError } from "../../subagent/team/team-store.js";
import {
  approveTeamPlan,
  readTeamPlan,
  replaceTeamPlan,
  submitTeamPlan,
  TeamPlanStoreError,
} from "../../subagent/team/team-plan.js";

const MAX_TEAM_PLAN_MODEL_BYTES = 32_768;
const TEAM_PLAN_TIMEOUT_MS = 10_000;

function resolvePlanToolDirs(context: Parameters<ToolHandler>[1]) {
  return resolveTeamWorkspaceDirs({
    workspaceIdentity: context.workspaceIdentity,
    workspacePath: context.workspaceRoot || context.workingDirectory,
  });
}

/** 存储层业务错误（含团队不存在）转为 in-band error 输出；其余异常向上冒泡为工具失败。 */
function toPlanErrorOutput(error: unknown): TeamPlanOutput {
  if (error instanceof TeamPlanStoreError) {
    return TeamPlanOutputSchema.parse({ status: "error", error: error.message, errorCode: error.code });
  }
  if (error instanceof TeamStoreError) {
    return TeamPlanOutputSchema.parse({ status: "error", error: error.message, errorCode: error.code });
  }
  throw error;
}

const teamPlanHandler: ToolHandler = async (input, context) => {
  const parsed = TeamPlanInputSchema.parse(input) as TeamPlanInput;
  // 批准是唯一的人类权限面操作：lead 侧工具收到 approve 一律拒绝，
  // 防止模型经 TeamPlan 自批绕过审批（制度性边界，见工具描述末尾约束）。
  if (parsed.operation === "approve") {
    return TeamPlanOutputSchema.parse({
      status: "error",
      error: "TeamPlan cannot approve; approval must go through the TeamPlanApprove tool (human confirmation)",
      errorCode: "team_plan_approve_gate",
    });
  }
  try {
    const dirs = resolvePlanToolDirs(context);
    switch (parsed.operation) {
      case "get": {
        const plan = await readTeamPlan({ dirs }, parsed.team_name);
        if (plan === undefined) {
          return TeamPlanOutputSchema.parse({
            status: "error",
            error: `No plan exists for team ${parsed.team_name}; create one with operation "replace"`,
            errorCode: "team_plan_not_found",
          });
        }
        return TeamPlanOutputSchema.parse({ status: "ok", plan });
      }
      case "replace": {
        if (parsed.plan === undefined) {
          return TeamPlanOutputSchema.parse({
            status: "error",
            error: 'operation "replace" requires a plan with members and tasks',
            errorCode: "team_plan_validation",
          });
        }
        const plan = await replaceTeamPlan({ dirs }, parsed.team_name, {
          sessionId: context.sessionId,
          members: parsed.plan.members,
          tasks: parsed.plan.tasks,
          ...(parsed.expected_revision === undefined ? {} : { expectedRevision: parsed.expected_revision }),
          ...(parsed.feedback === undefined ? {} : { feedback: parsed.feedback }),
        });
        return TeamPlanOutputSchema.parse({ status: "ok", plan });
      }
      case "submit": {
        if (parsed.expected_revision === undefined) {
          return TeamPlanOutputSchema.parse({
            status: "error",
            error: 'operation "submit" requires expected_revision',
            errorCode: "team_plan_conflict",
          });
        }
        const plan = await submitTeamPlan({ dirs }, parsed.team_name, {
          expectedRevision: parsed.expected_revision,
        });
        return TeamPlanOutputSchema.parse({ status: "ok", plan });
      }
    }
  } catch (error) {
    return toPlanErrorOutput(error);
  }
};

const teamPlanApproveHandler: ToolHandler = async (input, context) => {
  const parsed = TeamPlanInputSchema.parse(input) as TeamPlanInput;
  if (parsed.operation !== "approve") {
    return TeamPlanOutputSchema.parse({
      status: "error",
      error: 'TeamPlanApprove only supports operation "approve"',
      errorCode: "team_plan_approve_gate",
    });
  }
  if (parsed.expected_revision === undefined) {
    return TeamPlanOutputSchema.parse({
      status: "error",
      error: 'operation "approve" requires expected_revision',
      errorCode: "team_plan_conflict",
    });
  }
  try {
    const dirs = resolvePlanToolDirs(context);
    const plan = await approveTeamPlan({ dirs }, parsed.team_name, {
      expectedRevision: parsed.expected_revision,
    });
    return TeamPlanOutputSchema.parse({ status: "ok", plan, launchPlan: formatLaunchPlan(plan) });
  } catch (error) {
    return toPlanErrorOutput(error);
  }
};

// -----------------------------------------------
// 模型可见输出格式化
// -----------------------------------------------

function firstLineOf(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

/**
 * 批准后的实例化剧本（与 v2.8 templatePlan 同构）：lead 读后
 * Agent({ team_name, name }) spawn 成员 + TaskCreate 按序建任务
 * （depends 映射为 blockedBy 的任务 id）；成员 model 经 Agent 的 model 参数
 * 透传（成员模型路由：批准快照里的点名模型随 spawn 生效）。
 */
export function formatLaunchPlan(plan: TeamPlanRecord): string[] {
  const lines: string[] = [];
  if (plan.members.length > 0) {
    lines.push(`Spawn members via Agent({ team_name: "${plan.teamName}", name: "<member>" }):`);
    for (const member of plan.members) {
      // 成员模型路由：点名模型随剧本回灌，lead 按此把 model 传进 Agent spawn。
      lines.push(
        `- ${member.name}: ${firstLineOf(member.prompt)}` +
          (member.model === undefined ? "" : ` (model: ${member.model})`),
      );
    }
  }
  if (plan.tasks.length > 0) {
    lines.push("Create tasks via TaskCreate in order (map depends to blockedBy task ids):");
    for (const task of plan.tasks) {
      lines.push(
        `- ${task.subject}` +
          (task.owner === undefined ? "" : ` (owner: ${task.owner})`) +
          ((task.depends ?? []).length === 0 ? "" : ` [depends: ${(task.depends ?? []).join(", ")}]`),
      );
    }
  }
  return lines;
}

function formatTeamPlanModelContent(output: unknown): string {
  const result = TeamPlanOutputSchema.parse(output);
  if (result.status === "error") {
    return `TeamPlan error (${result.errorCode ?? "unknown"}): ${result.error ?? "unknown error"}`;
  }
  const plan = result.plan;
  if (plan === undefined) return "TeamPlan ok.";
  const head = `Team "${plan.teamName}" plan — revision ${plan.revision}, state ${plan.state}.`;
  const members = `Members (${plan.members.length}): ${plan.members.map((member) => member.name).join(", ")}.`;
  const tasks =
    plan.tasks.length === 0
      ? "Tasks: none."
      : `Tasks (${plan.tasks.length}): ${plan.tasks.map((task) => task.subject).join("; ")}.`;
  if (plan.state === "review_pending") {
    return [
      head,
      members,
      tasks,
      "Plan submitted and awaiting user approval. Do NOT start work, claim tasks, or spawn members — only the user can approve via the TeamPlanApprove confirmation.",
    ].join("\n");
  }
  return [head, members, tasks].join("\n");
}

function formatTeamPlanApproveModelContent(output: unknown): string {
  const result = TeamPlanOutputSchema.parse(output);
  if (result.status === "error") {
    return `TeamPlanApprove error (${result.errorCode ?? "unknown"}): ${result.error ?? "unknown error"}`;
  }
  const plan = result.plan;
  if (plan === undefined) return "TeamPlanApprove ok.";
  return [
    `Plan for team "${plan.teamName}" approved (revision ${plan.revision}). Instantiate it now:`,
    ...(result.launchPlan ?? []),
  ].join("\n");
}

// -----------------------------------------------
// Provider 描述
// -----------------------------------------------

const TEAM_PLAN_PROVIDER_DESCRIPTION = [
  "# TeamPlan",
  "",
  "Draft the full team plan (members + tasks + dependencies) BEFORE spawning any teammates, then submit it for human approval.",
  "",
  "Operations on one team's plan:",
  "- get: read the current plan (no revision needed).",
  "- replace: create or fully revise the plan. Creating requires NO expected_revision; revising requires the expected_revision from your last read.",
  "- submit: send the draft for human review (requires expected_revision). Only draft plans can be submitted.",
  "",
  "```json",
  '{"team_name": "refactor-team", "operation": "replace", "plan": {"members": [{"id": "be", "name": "backend", "prompt": "You own the storage layer"}], "tasks": [{"id": "t1", "subject": "Split store.ts", "owner": "backend"}]}}',
  '{"team_name": "refactor-team", "operation": "submit", "expected_revision": 1}',
  "```",
  "",
  "Task owner must match a planned member name; depends entries must reference planned task subjects.",
  "",
  "After submit the plan is review_pending. Do NOT start work, claim tasks, poll the plan, or call Agent to bypass review — only the user can approve, via the TeamPlanApprove confirmation.",
].join("\n");

const TEAM_PLAN_APPROVE_PROVIDER_DESCRIPTION = [
  "# TeamPlanApprove",
  "",
  "Request human approval of the submitted team plan. Calling this tool opens the user's permission dialog: approving it marks the plan approved; denying it rejects the change — then revise via TeamPlan replace (feedback records the rejection reason) and resubmit.",
  "",
  "```json",
  '{"team_name": "refactor-team", "operation": "approve", "expected_revision": 2}',
  "```",
  "",
  "On success the output contains a launchPlan: spawn members with Agent (team_name + name) and create tasks with TaskCreate in order (map depends to blockedBy task ids).",
].join("\n");

// -----------------------------------------------
// Tool Entries
// -----------------------------------------------

export const teamPlanToolEntry: ToolEntry = {
  capability: "Draft and submit the team plan (members + tasks) for human approval",
  metadata: {
    name: TEAM_PLAN_TOOL_NAME,
    description: TEAM_PLAN_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: TEAM_PLAN_TIMEOUT_MS,
    maxOutputBytes: MAX_TEAM_PLAN_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: teamPlanHandler,
  formatModelContent: formatTeamPlanModelContent,
  inputSchema: TeamPlanInputJsonSchema,
  outputSchema: TeamPlanOutputJsonSchema,
  runtimeInputSchema: TeamPlanInputSchema,
  runtimeOutputSchema: TeamPlanOutputSchema,
  permission: {
    permission: "team.plan",
    reason: "TeamPlan drafts and submits the team plan file for this workspace",
    riskLevel: "low",
    sideEffectScope: "workspace",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TEAM_PLAN_MODEL_BYTES,
    maxModelBytes: MAX_TEAM_PLAN_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_TEAM_PLAN_MODEL_BYTES, direction: "head" },
  },
  timeout: { defaultMs: TEAM_PLAN_TIMEOUT_MS, maxMs: TEAM_PLAN_TIMEOUT_MS, allowCallOverride: false },
  cancellation: { supported: true, cleanup: "none", userVisibleMessage: "TeamPlan was cancelled" },
  trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
};

export const teamPlanApproveToolEntry: ToolEntry = {
  capability: "Approve the submitted team plan via the human confirmation dialog",
  metadata: {
    name: TEAM_PLAN_APPROVE_TOOL_NAME,
    description: TEAM_PLAN_APPROVE_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: TEAM_PLAN_TIMEOUT_MS,
    maxOutputBytes: MAX_TEAM_PLAN_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    // 确认弹窗即人类批准面：这是 v2.10 审批制度的锚点，不是普通的风险提示。
    needsApproval: true,
  },
  handler: teamPlanApproveHandler,
  formatModelContent: formatTeamPlanApproveModelContent,
  inputSchema: TeamPlanInputJsonSchema,
  outputSchema: TeamPlanOutputJsonSchema,
  runtimeInputSchema: TeamPlanInputSchema,
  runtimeOutputSchema: TeamPlanOutputSchema,
  permission: {
    permission: "team.planApprove",
    reason: "TeamPlanApprove.confirmation: approving launches the team — only the user may decide",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // 批准是逐计划的用户决定：任何权限模式（含 yolo / plan）都要先问。
    alwaysAsk: true,
    // 绝不允许"总是允许"——那会把这个人类审批面永久关掉，lead 就能自批后续计划。
    askOptions: { allowAlways: false },
  },
  resultBudget: {
    maxInlineBytes: MAX_TEAM_PLAN_MODEL_BYTES,
    maxModelBytes: MAX_TEAM_PLAN_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_TEAM_PLAN_MODEL_BYTES, direction: "head" },
  },
  timeout: { defaultMs: TEAM_PLAN_TIMEOUT_MS, maxMs: TEAM_PLAN_TIMEOUT_MS, allowCallOverride: false },
  cancellation: { supported: true, cleanup: "none", userVisibleMessage: "TeamPlanApprove was cancelled" },
  trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
};
