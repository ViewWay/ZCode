// ============================================================
// Agent Tool - Subagent orchestration tool
// ============================================================
// 支持基于配置的子代理和异步启动。

import { z } from "zod";
import { parseModelPickerValue } from "@zcode/shared/model-selection";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import type { ModelSelection, ModelUsage } from "../model/index.js";
import { toToolJsonSchema } from "./json-schema.js";
import { TEAM_MEMBER_NAME_MAX_CHARS, teamNameSchema } from "./team.js";

export const AgentType = {
  GeneralPurpose: "general-purpose",
  Explore: "Explore",
} as const;

export type AgentType = string;

export const AgentInputSchema = z.object({
  description: z.string().describe("A short (3-5 word) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z
    .string()
    .optional()
    .describe("The type of specialized agent to use for this task"),
  // 普通单次 subagent 的模型仍由 Settings / Markdown profile 统一决定——若把
  // 调用级 model 暴露给普通路径，历史 tool call 会持续生成旧 override 并覆盖
  // 当前配置；model 只在下方 teammate 生成路径被消费（成员模型路由）。
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Set to true to run this agent in the background. You will be notified when it completes.",
    ),
  // Agent Teams（specs/agent-teams.md）：team_name + name 同时在场时走常驻
  // teammate 生成路径（不随单任务结束退出），其余入参维持 subagent 语义不变。
  team_name: teamNameSchema
    .optional()
    .describe("Spawn this agent as a named teammate of the given team (created via TeamCreate)."),
  name: z
    .string()
    .min(1)
    .max(TEAM_MEMBER_NAME_MAX_CHARS)
    .optional()
    .describe("Persistent teammate name within the team; required whenever team_name is set."),
  // 成员模型路由：lead 为常驻 teammate 点名模型（"providerId/modelId"）；仅
  // team_name + name 的 teammate 生成路径消费（优先于 profile 静态配置），
  // 普通单次 subagent 调用忽略该字段。
  model: z
    .string()
    .max(128)
    .optional()
    .describe(
      'Model for the spawned teammate, formatted "providerId/modelId"; ignored for non-teammate spawns.',
    ),
});

export type AgentInput = z.infer<typeof AgentInputSchema>;

export const AgentInputJsonSchema = toToolJsonSchema(AgentInputSchema);

/**
 * 成员模型路由：Agent 工具 model 入参解析为 child 的显式 ModelSelection 意图。
 * 复用 UI Picker 的 "providerId/modelId" 约定（首个 "/" 拆分，modelId 自身可含
 * "/"，如 openrouter/<org>/<model>），并兼容 "$reasoningLevel" 后缀；缺席或空白
 * 返回 undefined，调用方沿用既有优先级。在场但解析失败同样返回 undefined——是否
 * 按无效入参拒绝由调用方决定：Agent handler 的 teammate 路径拒绝，
 * runExploreAgent 兜底走既有选择链。
 */
export function parseTeammateModelLabel(label: string | undefined): ModelSelection | undefined {
  if (typeof label !== "string" || label.trim().length === 0) return undefined;
  try {
    return parseModelPickerValue(label);
  } catch {
    return undefined;
  }
}

export interface AgentTextContentBlock {
  type: "text";
  text: string;
}

export interface AgentCompletedOutput {
  status: "completed";
  agentId: string;
  agentType: AgentType;
  description: string;
  prompt: string;
  content: AgentTextContentBlock[];
  totalToolUseCount: number;
  totalDurationMs: number;
  totalTokens?: number;
  usage?: ModelUsage;
}

export interface AgentBackgroundedOutput {
  status: "async_launched";
  isAsync: true;
  agentId: string;
  agentType: AgentType;
  description: string;
  prompt: string;
  childSessionId: string;
  backgroundTaskId: string;
  outputFile: string;
  canReadOutputFile: boolean;
}

export type AgentOutput = AgentCompletedOutput | AgentBackgroundedOutput;

export const AgentTextContentBlockSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

export const AgentCompletedOutputSchema = z
  .object({
    status: z.literal("completed"),
    agentId: z.string(),
    agentType: z.string(),
    description: z.string(),
    prompt: z.string(),
    content: z.array(AgentTextContentBlockSchema),
    totalToolUseCount: z.number().int().nonnegative(),
    totalDurationMs: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative().optional(),
    usage: z.record(z.unknown()).optional(),
  })
  .strict();

export const AgentBackgroundedOutputSchema = z
  .object({
    status: z.literal("async_launched"),
    isAsync: z.literal(true),
    agentId: z.string(),
    agentType: z.string(),
    description: z.string(),
    prompt: z.string(),
    childSessionId: z.string(),
    backgroundTaskId: z.string(),
    outputFile: z.string(),
    canReadOutputFile: z.boolean(),
  })
  .strict();

export const AgentOutputSchema = z.union([
  AgentCompletedOutputSchema,
  AgentBackgroundedOutputSchema,
]);

export const AgentOutputJsonSchema = toToolJsonSchema(AgentOutputSchema);

export interface AgentToolCall {
  id: ToolCallId;
  name: "Agent";
  input: AgentInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface AgentToolResult {
  toolCallId: ToolCallId;
  output: AgentOutput;
  traceId: TraceId;
  durationMs: number;
}

export const AgentErrorCode = {
  SUBAGENT_UNAVAILABLE: "agent_subagent_unavailable",
  BACKGROUND_UNAVAILABLE: "agent_background_unavailable",
  UNKNOWN_AGENT_TYPE: "agent_unknown_type",
  CHILD_RUNTIME_FAILED: "agent_child_runtime_failed",
  INVALID_TEAMMATE_MODEL: "agent_invalid_teammate_model",
} as const;

export type AgentErrorCode = (typeof AgentErrorCode)[keyof typeof AgentErrorCode];
