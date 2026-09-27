import type {
  InteractionRequestOrigin,
  SessionId,
  ToolCallId,
  TurnId,
} from "@zcode/contracts";

export interface SubagentInteractionOriginContext {
  agentId: string;
  agentType: string;
  childSessionId: SessionId;
  description: string;
  parentSessionId: SessionId;
  parentToolCallId?: ToolCallId | string;
  parentTurnId?: TurnId;
  /** Agent Teams（specs/agent-teams.md AC4）：teammate 生成路径携带，普通 subagent 不带。 */
  teamName?: string;
  teammateName?: string;
}

export function buildSubagentInteractionOrigin(
  context: SubagentInteractionOriginContext,
  childTurnId?: TurnId,
): InteractionRequestOrigin {
  return {
    kind: "subagent",
    agentId: context.agentId,
    agentType: context.agentType,
    childSessionId: context.childSessionId,
    ...(childTurnId ? { childTurnId } : {}),
    description: context.description,
    parentSessionId: context.parentSessionId,
    ...(context.parentToolCallId ? { parentToolCallId: context.parentToolCallId } : {}),
    ...(context.parentTurnId ? { parentTurnId: context.parentTurnId } : {}),
    ...(context.teamName ? { teamName: context.teamName } : {}),
    ...(context.teammateName ? { teammateName: context.teammateName } : {}),
  };
}
