// ============================================================
// Agent Teams - 团队知识库工具契约（TeamKnowledgeWrite / TeamKnowledgeSearch）
// ============================================================
//
// specs/agent-teams.md P2（v2.3）：成员把可复用做法沉淀为知识文档（SKILL.md 式
// frontmatter + 正文），按关键词检索复用——「学会并共享新技能」的最小闭环。
// 存储于 <team-dir>/knowledge/<slug>.md；注册门与共享任务一致（lead 与 teammate）。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const TEAM_KNOWLEDGE_WRITE_TOOL_NAME = "TeamKnowledgeWrite";
export const TEAM_KNOWLEDGE_SEARCH_TOOL_NAME = "TeamKnowledgeSearch";

export const TEAM_KNOWLEDGE_SLUG_MAX_CHARS = 64;
export const TEAM_KNOWLEDGE_WHEN_TO_USE_MAX_CHARS = 500;
export const TEAM_KNOWLEDGE_CONTENT_MAX_CHARS = 32_000;

export const TeamKnowledgeWriteInputSchema = z
  .object({
    slug: z.string().min(1).max(TEAM_KNOWLEDGE_SLUG_MAX_CHARS),
    when_to_use: z.string().min(1).max(TEAM_KNOWLEDGE_WHEN_TO_USE_MAX_CHARS),
    content: z.string().min(1).max(TEAM_KNOWLEDGE_CONTENT_MAX_CHARS),
  })
  .strict();
export type TeamKnowledgeWriteInput = z.infer<typeof TeamKnowledgeWriteInputSchema>;

export const TeamKnowledgeWriteOutputSchema = z
  .object({
    slug: z.string(),
    fileName: z.string(),
    updated: z.boolean(),
  })
  .strict();
export type TeamKnowledgeWriteOutput = z.infer<typeof TeamKnowledgeWriteOutputSchema>;

export const TeamKnowledgeSearchInputSchema = z
  .object({
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();
export type TeamKnowledgeSearchInput = z.infer<typeof TeamKnowledgeSearchInputSchema>;

export const TeamKnowledgeSearchResultSchema = z.object({
  slug: z.string(),
  whenToUse: z.string(),
  author: z.string().optional(),
  snippet: z.string(),
});
export type TeamKnowledgeSearchResult = z.infer<typeof TeamKnowledgeSearchResultSchema>;

export const TeamKnowledgeSearchOutputSchema = z
  .object({
    query: z.string(),
    results: z.array(TeamKnowledgeSearchResultSchema),
  })
  .strict();
export type TeamKnowledgeSearchOutput = z.infer<typeof TeamKnowledgeSearchOutputSchema>;

function toToolSchemas() {
  return {
    TeamKnowledgeWriteInputJsonSchema: toToolJsonSchema(TeamKnowledgeWriteInputSchema),
    TeamKnowledgeWriteOutputJsonSchema: toToolJsonSchema(TeamKnowledgeWriteOutputSchema),
    TeamKnowledgeSearchInputJsonSchema: toToolJsonSchema(TeamKnowledgeSearchInputSchema),
    TeamKnowledgeSearchOutputJsonSchema: toToolJsonSchema(TeamKnowledgeSearchOutputSchema),
  } as const;
}

export const TEAM_KNOWLEDGE_TOOL_JSON_SCHEMAS = toToolSchemas();
export type TeamKnowledgeToolJsonSchemas = typeof TEAM_KNOWLEDGE_TOOL_JSON_SCHEMAS;
