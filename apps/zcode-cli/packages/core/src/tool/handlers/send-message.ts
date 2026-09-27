import {
  CoreErrorType,
  SEND_MESSAGE_TOOL_NAME,
  SendMessageInputJsonSchema,
  SendMessageInputSchema,
  SendMessageOutputSchema,
  TEAM_LEAD_MEMBER_NAME,
  createCoreError,
  type SendMessageInput,
  type SendMessageOutput,
  type TraceContext,
} from "@zcode/contracts";
import { randomUUID } from "node:crypto";
import type { ToolEntry, ToolHandler } from "../types.js";
import { assertNotOffPeakTurn } from "./off-peak.js";
import { resolveTeamWorkspaceDirs } from "../../subagent/team/team-paths.js";
import {
  broadcastTeamMessage,
  buildTeamMailboxMessage,
  appendTeamInboxMessage,
} from "../../subagent/team/team-mailbox.js";
import { listTeamNames, loadTeamFile } from "../../subagent/team/team-store.js";

const MAX_SEND_MESSAGE_MODEL_BYTES = 4096;
/**
 * SendMessage 续跑已完成子 Agent 走
 * resumeTerminalAgentInBackground，不携带闲时轮的 subagentModelOverride，子 Agent 按父会话
 * 常驻选择重建模型，请求全部计入用户 Coding Plan。闲时轮内子 Agent 均为前台同步完成，
 * SendMessage 唯一有意义的用途就是这条泄漏路径，因此直接拒绝。
 */
const OFF_PEAK_SEND_MESSAGE_HINT =
  "Spawn a new foreground Agent with the full context instead of resuming a completed one.";

const SEND_MESSAGE_PROVIDER_DESCRIPTION = [
  "# SendMessage",
  "",
  "Send a message to another agent.",
  "",
  "```json",
  '{"to": "agent_<uuid>", "summary": "assign task 1", "message": "start on task #1"}',
  "```",
  "",
  "Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool. Messages from agents are delivered automatically; you don't check an inbox. Refer to local agents by the `agentId` returned in the Agent spawn result. To resume a completed agent, use its `agentId`; it resumes in the background and you'll be notified when it finishes.",
  "",
  "Agent Teams: teammates are addressed by name (`to` = teammate name), `to: \"*\"` broadcasts to every teammate in the team. Teammates idle-wait for messages and wake up on delivery.",
].join("\n");

const SEND_MESSAGE_TOOL_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
  additionalProperties: false,
};

const sendMessageHandler: ToolHandler = async (input, context) => {
  const parsed = SendMessageInputSchema.parse(input) as SendMessageInput;
  assertNotOffPeakTurn(context, SEND_MESSAGE_TOOL_NAME, {
    hint: OFF_PEAK_SEND_MESSAGE_HINT,
    recoverable: true,
  });

  // Agent Teams 路由（specs/agent-teams.md）：to ∈ 团队成员 → 写队友邮箱；
  // to === "*" → 广播（发送者除外）。团队成员寻址优先于本地 agentId 寻址，
  // 因为成员名与 agentId 命名空间不同，不会冲突。
  const teamDelivery = await deliverToTeamMailbox(parsed, context);
  if (teamDelivery) return teamDelivery;

  if (!context.subagentPort?.sendMessage) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Subagent port is not configured for SendMessage",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: SEND_MESSAGE_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  return context.subagentPort.sendMessage(
    {
      sessionId: context.sessionId,
      turnId: context.turnId,
      parentToolCallId: context.toolCallId,
      to: parsed.to,
      summary: parsed.summary,
      message: parsed.message,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
      trace: resolveToolTraceContext(context),
    },
    { signal: context.abortSignal },
  ) satisfies Promise<SendMessageOutput>;
};

/**
 * 尝试把消息投递进团队邮箱；未命中团队寻址（无团队 / to 不是成员也不是 *）返回
 * undefined，调用方维持既有 agentId 路由。团队解析规则与共享任务一致：workspace
 * 恰有一个团队时生效（specs/agent-teams.md）。
 */
async function deliverToTeamMailbox(
  parsed: SendMessageInput,
  context: Parameters<ToolHandler>[1],
): Promise<SendMessageOutput | undefined> {
  try {
    const dirs = resolveTeamWorkspaceDirs({
      workspaceIdentity: context.workspaceIdentity,
      workspacePath: context.workspaceRoot || context.workingDirectory,
    });
    const teamNames = await listTeamNames({ dirs });
    if (teamNames.length !== 1) return undefined;
    const teamName = teamNames[0]!;
    const team = await loadTeamFile({ dirs }, teamName);
    if (!team) return undefined;

    const trace = resolveToolTraceContext(context);
    if (parsed.to === "*") {
      const result = await broadcastTeamMessage(dirs, teamName, team, {
        // v1：lead 会话即 TEAM_LEAD_MEMBER_NAME 成员；teammate 自身的 from 随 teammate 上下文注入接入。
        from: resolveTeamMessageSender(context),
        summary: parsed.summary,
        payload: { kind: "text", text: parsed.message },
        sentAt: new Date().toISOString(),
        traceContext: trace,
      });
      return SendMessageOutputSchema.parse({
        status: "success",
        messageId: `msg_${randomUUID()}`,
        delivery: "teammate_mailbox",
        broadcastTo: result.deliveredTo,
        broadcastFailures: result.failures.map((failure) => ({ ...failure })),
        message: `Broadcast queued for ${result.deliveredTo.length} teammate(s)${
          result.failures.length > 0 ? `, ${result.failures.length} delivery failure(s)` : ""
        }.`,
      }) satisfies SendMessageOutput;
    }

    const member = team.members.find((candidate) => candidate.name === parsed.to);
    if (!member) {
      // Agent Teams v2（specs/agent-teams.md）：teammate 会话寻址不存在的成员时给出明确业务失败；
      // 主会话保持回落 agentId 路由（团队存在时 lead 仍可按 agentId 继续消息普通子代理）。
      if (context.teamMemberIdentity !== undefined) {
        throw createCoreError(
          CoreErrorType.ToolExecutionFailed,
          `Unknown teammate "${parsed.to}" in team "${teamName}". Use a member name, "team_lead", or "*".`,
          { recoverable: true },
        );
      }
      return undefined;
    }
    const messageId = await appendTeamInboxMessage(
      dirs,
      teamName,
      member.name,
      buildTeamMailboxMessage({
        from: resolveTeamMessageSender(context),
        to: member.name,
        summary: parsed.summary,
        payload: { kind: "text", text: parsed.message },
        traceContext: trace,
      }),
    );
    return SendMessageOutputSchema.parse({
      status: "success",
      messageId,
      delivery: "teammate_mailbox",
      teammate: member.name,
      message: `Message queued for teammate "${member.name}"; they will wake up on delivery.`,
    }) satisfies SendMessageOutput;
  } catch (error) {
    // 团队邮箱路由失败不应吞掉消息：向上抛出业务错误，让模型看到投递失败原因。
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      `Team mailbox delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error instanceof Error ? error : undefined, recoverable: true },
    );
  }
}

export const sendMessageToolEntry: ToolEntry = {
  capability: "Send a short message to a local agent",
  metadata: {
    name: SEND_MESSAGE_TOOL_NAME,
    description: SEND_MESSAGE_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 10000,
    maxOutputBytes: MAX_SEND_MESSAGE_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: sendMessageHandler,
  formatModelContent: formatSendMessageModelContent,
  inputSchema: SendMessageInputJsonSchema,
  outputSchema: SEND_MESSAGE_TOOL_OUTPUT_SCHEMA,
  runtimeInputSchema: SendMessageInputSchema,
  runtimeOutputSchema: SendMessageOutputSchema,
  permission: {
    permission: "agent.message.send",
    reason: "SendMessage writes a message to a local agent queue",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_SEND_MESSAGE_MODEL_BYTES,
    maxModelBytes: MAX_SEND_MESSAGE_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_SEND_MESSAGE_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 10000,
    maxMs: 10000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "SendMessage was cancelled before delivery status returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatSendMessageModelContent(output: unknown): string {
  const result = SendMessageOutputSchema.parse(output);
  if (result.message) return result.message;
  if (result.status === "success") {
    if (result.delivery) {
      return `Message ${result.messageId} was ${result.delivery} for local agent ${result.agentId ?? result.taskId ?? "unknown"}.`;
    }
    return `Message ${result.messageId} was queued for local agent ${result.agentId ?? result.taskId ?? "unknown"}.`;
  }
  return `Message ${result.messageId} failed to send to local agent ${result.agentId ?? result.taskId ?? "unknown"}: ${result.error ?? "unknown error"}.`;
}

/**
 * Agent Teams v2（specs/agent-teams.md）：解析消息发送方在团队内的身份。
 * 修复依据：此前 from 硬编码 team_lead——teammate 只能收消息不能发消息，
 * 成员向 lead 汇报与成员互聊是死信。主会话仍是 lead，teammate 会话用自己的成员名。
 */
export function resolveTeamMessageSender(
  context: Pick<Parameters<ToolHandler>[1], "teamMemberIdentity">,
): string {
  return context.teamMemberIdentity?.memberName ?? TEAM_LEAD_MEMBER_NAME;
}

function resolveToolTraceContext(context: Parameters<ToolHandler>[1]): TraceContext {
  return (
    context.traceContext ?? {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    }
  );
}
