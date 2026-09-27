// ============================================================
// Agent Teams - teammate 常驻生成契约（SubagentPort.spawnTeammate）
// ============================================================
//
// specs/agent-teams.md：Agent({ team_name, name }) 走 teammate 生成路径——
// 具名、常驻、可空闲待命，不随单任务结束退出；独立 abort 生命周期，
// 仅随 lead 会话终止 / TeamDelete / shutdown 而终止。

import { z } from "zod";
import { teamMemberNameSchema, teamNameSchema } from "./team.js";
import { toToolJsonSchema } from "./json-schema.js";
import type { AgentBackgroundedOutput } from "./agent.js";

export const TEAMMATE_LAUNCH_STATUS = "teammate_launched" as const;

export const TeammateSpawnIdentitySchema = z.object({
  teamName: teamNameSchema,
  teammateName: teamMemberNameSchema,
});
export type TeammateSpawnIdentity = z.infer<typeof TeammateSpawnIdentitySchema>;

/** Agent 工具输出新增的 teammate 分支（与 async_launched 并列）。 */
export const TeammateLaunchedOutputSchema = z.object({
  status: z.literal(TEAMMATE_LAUNCH_STATUS),
  isAsync: z.literal(true),
  agentId: z.string(),
  agentType: z.string(),
  description: z.string(),
  prompt: z.string(),
  childSessionId: z.string(),
  backgroundTaskId: z.string(),
  teamName: teamNameSchema,
  teammateName: teamMemberNameSchema,
  outputFile: z.string(),
  canReadOutputFile: z.boolean(),
});
export type TeammateLaunchedOutput = z.infer<typeof TeammateLaunchedOutputSchema>;

export const TeammateLaunchedOutputJsonSchema = toToolJsonSchema(TeammateLaunchedOutputSchema);

/** Agent 工具输出：completed | async_launched | teammate_launched。 */
export type AgentToolOutputWithTeammate = AgentBackgroundedOutput | TeammateLaunchedOutput;

/** 判断 Agent 工具入参是否走 teammate 生成路径（team_name 与 name 必须同时在场）。 */
export function isTeammateAgentInput(input: {
  team_name?: string;
  name?: string;
  run_in_background?: boolean;
}): boolean {
  const hasTeamIdentity =
    typeof input.team_name === "string" &&
    input.team_name.trim().length > 0 &&
    typeof input.name === "string" &&
    input.name.trim().length > 0;
  if (!hasTeamIdentity) return false;
  // run_in_background 与 teammate 语义互斥：teammate 本身就是常驻后台形态。
  return input.run_in_background !== true;
}
