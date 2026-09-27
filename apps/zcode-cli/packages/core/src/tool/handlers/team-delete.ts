// ============================================================
// TeamDelete Tool Handler - 解散团队并清理磁盘事实
// ============================================================
//
// specs/agent-teams.md（AC5 完整语义）：TeamDelete 优先经 SubagentPort.shutdownTeam
// 执行「shutdown_request 投递 → 等成员收敛（上限 30s）→ 强制终止残留 → 删目录」；
// shutdownRequested 即真实投递数。端口/teammate 运行时缺失时回退为「仅删目录」
// （幂等 not_found 语义不变），保证无 subagent runtime 的最小部署仍可清理磁盘事实。

import {
  TEAM_DELETE_TOOL_NAME,
  TeamDeleteInputJsonSchema,
  TeamDeleteInputSchema,
  TeamDeleteOutputJsonSchema,
  TeamDeleteOutputSchema,
  type TeamDeleteInput,
  type TeamDeleteOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { resolveTeamWorkspaceDirs } from "../../subagent/team/team-paths.js";
import { deleteTeamDir } from "../../subagent/team/team-store.js";

const MAX_TEAM_DELETE_MODEL_BYTES = 4_096;
const TEAM_DELETE_TIMEOUT_MS = 10_000;

const TEAM_DELETE_PROVIDER_DESCRIPTION = [
  "# TeamDelete",
  "",
  "Disband a named agent team: teammates receive a shutdown request, then the team registry, mailboxes and shared tasks are removed from disk.",
  "",
  "```json",
  '{"name": "refactor-team"}',
  "```",
  "",
  "Deleting a team that does not exist returns status `not_found` (idempotent).",
].join("\n");

const teamDeleteHandler: ToolHandler = async (input, context) => {
  const parsed = TeamDeleteInputSchema.parse(input) as TeamDeleteInput;
  // 完整语义路径：runtime 端口在场时由唯一写入者（runner）执行关停编排。
  const shutdownTeam = context.subagentPort?.shutdownTeam;
  if (shutdownTeam) {
    const result = await shutdownTeam.call(context.subagentPort, {
      teamName: parsed.name,
      workspaceIdentity: context.workspaceIdentity,
      workspaceRoot: context.workspaceRoot,
      workingDirectory: context.workingDirectory,
    });
    return TeamDeleteOutputSchema.parse({
      status: result.status,
      shutdownRequested: result.requested,
      ...(result.status === "deleted"
        ? {}
        : { message: `Team "${parsed.name}" does not exist in this workspace.` }),
    }) satisfies TeamDeleteOutput;
  }
  // 回退路径：无 teammate 运行时（最小部署）仅清理磁盘事实。
  const dirs = resolveTeamWorkspaceDirs({
    workspaceIdentity: context.workspaceIdentity,
    workspacePath: context.workspaceRoot || context.workingDirectory,
  });
  const { deleted } = await deleteTeamDir({ dirs }, parsed.name);
  const output = TeamDeleteOutputSchema.parse({
    status: deleted ? "deleted" : "not_found",
    shutdownRequested: 0,
    ...(deleted
      ? {}
      : { message: `Team "${parsed.name}" does not exist in this workspace.` }),
  }) satisfies TeamDeleteOutput;
  return output;
};

function formatTeamDeleteModelContent(output: unknown): string {
  const result = TeamDeleteOutputSchema.parse(output);
  return result.status === "deleted"
    ? `Team deleted; registry, mailboxes and shared tasks were removed.`
    : `No team matched; nothing was removed.`;
}

export const teamDeleteToolEntry: ToolEntry = {
  capability: "Disband a named agent team and clean up its registry, mailboxes and tasks",
  metadata: {
    name: TEAM_DELETE_TOOL_NAME,
    description: TEAM_DELETE_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: true,
    concurrentSafe: false,
    timeoutMs: TEAM_DELETE_TIMEOUT_MS,
    maxOutputBytes: MAX_TEAM_DELETE_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: false,
  },
  handler: teamDeleteHandler,
  formatModelContent: formatTeamDeleteModelContent,
  inputSchema: TeamDeleteInputJsonSchema,
  outputSchema: TeamDeleteOutputJsonSchema,
  runtimeInputSchema: TeamDeleteInputSchema,
  runtimeOutputSchema: TeamDeleteOutputSchema,
  permission: {
    permission: "team.manage",
    reason: "TeamDelete removes the team registry directory for this workspace",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TEAM_DELETE_MODEL_BYTES,
    maxModelBytes: MAX_TEAM_DELETE_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_TEAM_DELETE_MODEL_BYTES, direction: "head" },
  },
  timeout: { defaultMs: TEAM_DELETE_TIMEOUT_MS, maxMs: TEAM_DELETE_TIMEOUT_MS, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "TeamDelete was cancelled; the team directory may be partially removed",
  },
  trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
};
