// ============================================================
// TeamCreate Tool Handler - 创建团队注册表（TeamFile）
// ============================================================
//
// specs/agent-teams.md AC1：TeamCreate 后磁盘存在 TeamFile，含 lead 成员；
// 同名重复调用幂等返回既有团队。写入所有权归 runtime（本 handler），
// services/UI 只读发现，不新增第二条写入路径。

import {
  TEAM_CREATE_TOOL_NAME,
  TeamCreateInputJsonSchema,
  TeamCreateInputSchema,
  TeamCreateOutputJsonSchema,
  TeamCreateOutputSchema,
  type TeamCreateInput,
  type TeamCreateOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { resolveTeamWorkspaceDirs } from "../../subagent/team/team-paths.js";
import { createOrGetTeam } from "../../subagent/team/team-store.js";

const MAX_TEAM_CREATE_MODEL_BYTES = 8_192;
const TEAM_CREATE_TIMEOUT_MS = 10_000;

const TEAM_CREATE_PROVIDER_DESCRIPTION = [
  "# TeamCreate",
  "",
  "Create a named agent team in this workspace and register yourself as the team lead.",
  "",
  "```json",
  '{"name": "refactor-team", "description": "Parallel refactor of the storage layer"}',
  "```",
  "",
  "Creating a team with an existing name returns the existing team unchanged (idempotent).",
  "After creating a team, spawn persistent teammates with the Agent tool by passing both `team_name` and `name`.",
  "Teammates coordinate through SendMessage (recipient = teammate name, `*` = broadcast) and a shared task list (TaskCreate/TaskUpdate/TaskGet/TaskList).",
].join("\n");

const teamCreateHandler: ToolHandler = async (input, context) => {
  const parsed = TeamCreateInputSchema.parse(input) as TeamCreateInput;
  const dirs = resolveTeamWorkspaceDirs({
    workspaceIdentity: context.workspaceIdentity,
    workspacePath: context.workspaceRoot || context.workingDirectory,
  });
  const { team, status } = await createOrGetTeam(
    { dirs },
    {
      name: parsed.name,
      description: parsed.description,
      // lead 的 agentId 在主会话没有 child agent 概念，用会话 id 稳定标识；
      // 需要跨会话聚合时 services 层再按 leadSessionId 归并。
      leadAgentId: `lead_${context.sessionId}`,
      leadSessionId: context.sessionId,
      leadWorkingDirectory: context.workingDirectory,
      useWorktree: parsed.useWorktree,
    },
  );
  return TeamCreateOutputSchema.parse({ status, team }) satisfies TeamCreateOutput;
};

function formatTeamCreateModelContent(output: unknown): string {
  const result = TeamCreateOutputSchema.parse(output);
  const memberNames = result.team.members.map((member) => member.name).join(", ");
  const head =
    result.status === "created"
      ? `Team "${result.team.name}" created.`
      : `Team "${result.team.name}" already exists; returning it unchanged.`;
  return `${head}\nMembers: ${memberNames}\nSpawn teammates with Agent({ team_name: "${result.team.name}", name: "<teammate>", ... }).\nAs lead, coordinate rather than implement: dispatch tasks (TaskCreate/TaskUpdate), review delivered work, and unblock blockers — avoid editing files yourself while teammates are active.`;
}

export const teamCreateToolEntry: ToolEntry = {
  capability: "Create a named agent team and register the lead member",
  metadata: {
    name: TEAM_CREATE_TOOL_NAME,
    description: TEAM_CREATE_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: TEAM_CREATE_TIMEOUT_MS,
    maxOutputBytes: MAX_TEAM_CREATE_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: teamCreateHandler,
  formatModelContent: formatTeamCreateModelContent,
  inputSchema: TeamCreateInputJsonSchema,
  outputSchema: TeamCreateOutputJsonSchema,
  runtimeInputSchema: TeamCreateInputSchema,
  runtimeOutputSchema: TeamCreateOutputSchema,
  permission: {
    permission: "team.manage",
    reason: "TeamCreate writes the team registry file for this workspace",
    riskLevel: "low",
    sideEffectScope: "workspace",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TEAM_CREATE_MODEL_BYTES,
    maxModelBytes: MAX_TEAM_CREATE_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_TEAM_CREATE_MODEL_BYTES, direction: "head" },
  },
  timeout: { defaultMs: TEAM_CREATE_TIMEOUT_MS, maxMs: TEAM_CREATE_TIMEOUT_MS, allowCallOverride: false },
  cancellation: { supported: true, cleanup: "none", userVisibleMessage: "TeamCreate was cancelled" },
  trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
};
