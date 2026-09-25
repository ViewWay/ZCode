// ============================================================
// TeamDelete Tool Handler - 解散团队并清理磁盘事实
// ============================================================
//
// specs/agent-teams.md：TeamDelete 向全部存活 teammate 发 shutdown_request，
// 等待审批后删除 TeamFile 与 mailbox。teammate 运行时（shutdown 投递）在后续
// 提交接入；本版本先落「清理事实源 + 幂等 not_found」语义（AC5 的清理半边），
// shutdownRequested 恒为 0，字段先行保证协议稳定，不因后续增量改 wire 形状。

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
