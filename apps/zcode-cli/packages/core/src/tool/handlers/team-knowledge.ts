// ============================================================
// Team Knowledge Tools Handlers（TeamKnowledgeWrite / TeamKnowledgeSearch）
// ============================================================
//
// specs/agent-teams.md P2（v2.3）：团队知识库工具面。注册门与共享任务一致
// （includeTeamTasks：lead 与 teammate 可用）；写入方身份按会话解析
// （teammate=成员名，主会话=team_lead）。

import {
  TEAM_KNOWLEDGE_SEARCH_TOOL_NAME,
  TEAM_KNOWLEDGE_TOOL_JSON_SCHEMAS,
  TEAM_KNOWLEDGE_WRITE_TOOL_NAME,
  TEAM_LEAD_MEMBER_NAME,
  TeamKnowledgeSearchInputSchema,
  TeamKnowledgeSearchOutputSchema,
  TeamKnowledgeWriteInputSchema,
  TeamKnowledgeWriteOutputSchema,
  type TeamKnowledgeSearchInput,
  type TeamKnowledgeWriteInput,
  TeamKnowledgePromoteInputSchema,
  TeamKnowledgePromoteOutputSchema,
  type TeamKnowledgePromoteInput,
  type ToolPermissionPatternSource,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { resolveTeamWorkspaceDirs } from "../../subagent/team/team-paths.js";
import { resolveSingleTeamName, TeamStoreError } from "../../subagent/team/team-store.js";
import {
  promoteTeamKnowledge,
  searchTeamKnowledge,
  writeTeamKnowledge,
} from "../../subagent/team/team-knowledge.js";

const MAX_TEAM_KNOWLEDGE_MODEL_BYTES = 16_384;
const TEAM_KNOWLEDGE_TIMEOUT_MS = 10_000;

function resolveKnowledgeToolDirs(context: Parameters<ToolHandler>[1]) {
  return resolveTeamWorkspaceDirs({
    workspaceIdentity: context.workspaceIdentity,
    workspacePath: context.workspaceRoot || context.workingDirectory,
  });
}

function toKnowledgeFailure(error: unknown): { result: false; errorCode: number; message: string } {
  return { result: false, errorCode: 3002, message: error instanceof Error ? error.message : String(error) };
}

const knowledgeWriteHandler: ToolHandler = async (input, context) => {
  try {
    const parsed = TeamKnowledgeWriteInputSchema.parse(input) as TeamKnowledgeWriteInput;
    const dirs = resolveKnowledgeToolDirs(context);
    const teamName = await resolveSingleTeamName({ dirs });
    const author = context.teamMemberIdentity?.memberName ?? TEAM_LEAD_MEMBER_NAME;
    return await writeTeamKnowledge({ dirs }, teamName, {
      slug: parsed.slug,
      whenToUse: parsed.when_to_use,
      content: parsed.content,
      author,
    });
  } catch (error) {
    if (error instanceof TeamStoreError) return toKnowledgeFailure(error);
    throw error;
  }
};

const knowledgeSearchHandler: ToolHandler = async (input, context) => {
  try {
    const parsed = TeamKnowledgeSearchInputSchema.parse(input) as TeamKnowledgeSearchInput;
    const dirs = resolveKnowledgeToolDirs(context);
    const teamName = await resolveSingleTeamName({ dirs });
    return await searchTeamKnowledge({ dirs }, teamName, parsed);
  } catch (error) {
    if (error instanceof TeamStoreError) return toKnowledgeFailure(error);
    throw error;
  }
};

const knowledgePromoteHandler: ToolHandler = async (input, context) => {
  try {
    const parsed = TeamKnowledgePromoteInputSchema.parse(input) as TeamKnowledgePromoteInput;
    const dirs = resolveKnowledgeToolDirs(context);
    const teamName = await resolveSingleTeamName({ dirs });
    return await promoteTeamKnowledge({ dirs }, teamName, parsed.slug, {
      skillName: parsed.skill_name,
    });
  } catch (error) {
    if (error instanceof TeamStoreError) return toKnowledgeFailure(error);
    throw error;
  }
};

function formatKnowledgeWriteModelContent(output: unknown): string {
  const result = TeamKnowledgeWriteOutputSchema.parse(output);
  return `Knowledge "${result.slug}" ${result.updated ? "updated" : "created"} (${result.fileName}). Teammates can find it via TeamKnowledgeSearch.`;
}

function formatKnowledgeSearchModelContent(output: unknown): string {
  const result = TeamKnowledgeSearchOutputSchema.parse(output);
  if (result.results.length === 0) return `No knowledge matched "${result.query}".`;
  return result.results
    .map((hit, index) => `${index + 1}. ${hit.slug} — ${hit.whenToUse}${hit.author ? ` (by ${hit.author})` : ""}\n   ${hit.snippet}`)
    .join("\n");
}

function formatKnowledgePromoteModelContent(output: unknown): string {
  const result = TeamKnowledgePromoteOutputSchema.parse(output);
  return `Knowledge promoted to skill "${result.skillName}" at ${result.path}${result.updated ? " (updated)" : ""}. It becomes loadable via the Skill tool in NEW sessions.`;
}

const TEAM_KNOWLEDGE_PERMISSION = {
  permission: "team.knowledge",
  riskLevel: "low" as const,
  sideEffectScope: "workspace" as const,
  needsApproval: false,
  patternSources: ["toolName"] as ToolPermissionPatternSource[],
  alwaysAllowPatternSources: ["toolName"] as ToolPermissionPatternSource[],
  denyPriority: "beforeAsk" as const,
};

function teamKnowledgeToolEntry(input: {
  name: string;
  capability: string;
  description: string;
  handler: ToolHandler;
  inputSchema: (typeof TEAM_KNOWLEDGE_TOOL_JSON_SCHEMAS)["TeamKnowledgeWriteInputJsonSchema"];
  outputSchema: (typeof TEAM_KNOWLEDGE_TOOL_JSON_SCHEMAS)["TeamKnowledgeWriteOutputJsonSchema"];
  runtimeInputSchema: unknown;
  runtimeOutputSchema: unknown;
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
      timeoutMs: TEAM_KNOWLEDGE_TIMEOUT_MS,
      maxOutputBytes: MAX_TEAM_KNOWLEDGE_MODEL_BYTES,
      sideEffectScope: "workspace",
      riskLevel: "low",
      needsApproval: false,
    },
    handler: input.handler,
    formatModelContent: input.formatModelContent,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    runtimeInputSchema: input.runtimeInputSchema,
    runtimeOutputSchema: input.runtimeOutputSchema,
    permission: { ...TEAM_KNOWLEDGE_PERMISSION, reason: `${input.name} reads or writes the team knowledge base` },
    resultBudget: {
      maxInlineBytes: MAX_TEAM_KNOWLEDGE_MODEL_BYTES,
      maxModelBytes: MAX_TEAM_KNOWLEDGE_MODEL_BYTES,
      strategy: "truncate",
      preview: { maxBytes: MAX_TEAM_KNOWLEDGE_MODEL_BYTES, direction: "head" },
    },
    timeout: { defaultMs: TEAM_KNOWLEDGE_TIMEOUT_MS, maxMs: TEAM_KNOWLEDGE_TIMEOUT_MS, allowCallOverride: false },
    cancellation: { supported: true, cleanup: "none", userVisibleMessage: `${input.name} was cancelled` },
    trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
  };
}

export const teamKnowledgeWriteToolEntry: ToolEntry = teamKnowledgeToolEntry({
  name: TEAM_KNOWLEDGE_WRITE_TOOL_NAME,
  capability: "Write a reusable how-to into the team knowledge base",
  description: [
    "# TeamKnowledgeWrite",
    "",
    "Write a reusable how-to/lesson into the team knowledge base so teammates can find it.",
    "Use it after solving something non-obvious (a workaround, a root cause, a validation recipe).",
    "",
    '```json\n{"slug": "fix-flaky-db-test", "when_to_use": "When the integration test flakes on CI", "content": "Root cause: ... Steps: ..."}\n```',
  ].join("\n"),
  handler: knowledgeWriteHandler,
  inputSchema: TEAM_KNOWLEDGE_TOOL_JSON_SCHEMAS.TeamKnowledgeWriteInputJsonSchema,
  outputSchema: TEAM_KNOWLEDGE_TOOL_JSON_SCHEMAS.TeamKnowledgeWriteOutputJsonSchema,
  runtimeInputSchema: TeamKnowledgeWriteInputSchema,
  runtimeOutputSchema: TeamKnowledgeWriteOutputSchema,
  formatModelContent: formatKnowledgeWriteModelContent,
  readOnly: false,
});

export const teamKnowledgeSearchToolEntry: ToolEntry = teamKnowledgeToolEntry({
  name: TEAM_KNOWLEDGE_SEARCH_TOOL_NAME,
  capability: "Search the team knowledge base for prior solutions",
  description: [
    "# TeamKnowledgeSearch",
    "",
    "Search the team knowledge base before starting non-trivial work — a teammate may have already solved it.",
    "",
    '```json\n{"query": "flaky test", "limit": 5}\n```',
  ].join("\n"),
  handler: knowledgeSearchHandler,
  inputSchema: TEAM_KNOWLEDGE_TOOL_JSON_SCHEMAS.TeamKnowledgeSearchInputJsonSchema,
  outputSchema: TEAM_KNOWLEDGE_TOOL_JSON_SCHEMAS.TeamKnowledgeSearchOutputJsonSchema,
  runtimeInputSchema: TeamKnowledgeSearchInputSchema,
  runtimeOutputSchema: TeamKnowledgeSearchOutputSchema,
  formatModelContent: formatKnowledgeSearchModelContent,
  readOnly: true,
});

export const teamKnowledgePromoteToolEntry: ToolEntry = teamKnowledgeToolEntry({
  name: "TeamKnowledgePromote",
  capability: "Promote a team knowledge doc into a user-level skill",
  description: [
    "# TeamKnowledgePromote",
    "",
    "Promote a knowledge document into a user-level skill (~/.zcode/skills/<name>/SKILL.md) so it becomes loadable via the Skill tool in new sessions, across projects.",
    "",
    '```json\n{"slug": "fix-flaky-db-test"}\n```',
  ].join("\n"),
  handler: knowledgePromoteHandler,
  inputSchema: TEAM_KNOWLEDGE_TOOL_JSON_SCHEMAS.TeamKnowledgePromoteInputJsonSchema,
  outputSchema: TEAM_KNOWLEDGE_TOOL_JSON_SCHEMAS.TeamKnowledgePromoteOutputJsonSchema,
  runtimeInputSchema: TeamKnowledgePromoteInputSchema,
  runtimeOutputSchema: TeamKnowledgePromoteOutputSchema,
  formatModelContent: formatKnowledgePromoteModelContent,
  readOnly: false,
});
