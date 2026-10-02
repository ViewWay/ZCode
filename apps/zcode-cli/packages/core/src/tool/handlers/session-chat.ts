// ============================================================
// Session Chat Tools (实验) - SessionList / SessionTalk / SessionCreate
// ============================================================
// 会话互聊工具面（specs 对齐 MiMo 实验室同名功能）：允许模型呼叫同 workspace 内
// 其它存活会话、创建协作者会话。宿主（协议 server）在实验开关开启时注入
// SessionChatPort；端口缺席即不注册工具（fail-closed）。
// 与 agent-teams 完全独立：不读写 TeamFile/mailbox，不给 team 成员产生副作用。
// SessionTalk 是 fire-and-return：投递只进目标会话的 admission；回应由接收方
// 模型调用 SessionTalk 发回来源会话（消息体头部携带来源标注与回信指引）。

import {
  CoreErrorType,
  SESSION_CREATE_TOOL_NAME,
  SESSION_LIST_TOOL_NAME,
  SESSION_TALK_TOOL_NAME,
  SessionCreateInputJsonSchema,
  SessionCreateInputSchema,
  SessionCreateOutputJsonSchema,
  SessionCreateOutputSchema,
  SessionListInputJsonSchema,
  SessionListInputSchema,
  SessionListOutputJsonSchema,
  SessionListOutputSchema,
  SessionTalkInputJsonSchema,
  SessionTalkInputSchema,
  SessionTalkOutputJsonSchema,
  SessionTalkOutputSchema,
  createCoreError,
  type SessionCreateInput,
  type SessionCreateOutput,
  type SessionListOutput,
  type SessionTalkInput,
  type SessionTalkOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_SESSION_CHAT_MODEL_BYTES = 8_192;
const SESSION_LIST_TIMEOUT_MS = 10_000;
const SESSION_TALK_TIMEOUT_MS = 15_000;
const SESSION_CREATE_TIMEOUT_MS = 30_000;

const SESSION_LIST_DESCRIPTION = [
  "# SessionList",
  "",
  "List other live sessions in this workspace that you can chat with (session inter-chat).",
  "",
  "```json",
  "{}",
  "```",
  "",
  "Each entry has sessionId, title and status (idle/running). Use SessionTalk with a sessionId to send a message to that session's model.",
].join("\n");

const SESSION_TALK_DESCRIPTION = [
  "# SessionTalk",
  "",
  "Send a message to another session in this workspace and return immediately (fire-and-return).",
  "",
  "```json",
  '{"targetSessionId": "sess-123", "message": "Which auth middleware did you end up using, and why?"}',
  "```",
  "",
  "The message is delivered as user input into the target session, clearly marked as coming from another session (yours).",
  "Rules:",
  "- Get sessionId from SessionList; never guess or reuse an id from another workspace.",
  "- The target session does NOT see your conversation. Make the message self-contained: include the needed code, decisions or file paths inline.",
  "- Replies are not returned by this tool. The target's model is instructed to reply by calling SessionTalk back with your sessionId, which arrives in your next turn.",
  "- If the target is busy, the message is queued for its next turn (status \"queued\"). Do not spam; one delivery is enough.",
].join("\n");

const SESSION_CREATE_DESCRIPTION = [
  "# SessionCreate",
  "",
  "Create a collaborator session in this workspace, optionally starting it with a first message.",
  "",
  "```json",
  '{"title": "coverage audit", "firstMessage": "Run pnpm test in packages/services and summarize failures."}',
  "```",
  "",
  "The new session appears in the workspace sidebar and its model can chat back via SessionTalk. Omit firstMessage to create an idle session the user can prompt directly.",
].join("\n");

function requireSessionChatPort(toolName: string, port: unknown) {
  if (!port) {
    // 注册门以端口存在为准；走到这里说明接线故障（照 escalate），不是一种结局。
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Session chat port is not configured for " + toolName,
      { context: { toolName }, recoverable: false },
    );
  }
}

const sessionListHandler: ToolHandler = async (input, context) => {
  SessionListInputSchema.parse(input);
  requireSessionChatPort(SESSION_LIST_TOOL_NAME, context.sessionChatPort);
  const sessions = await context.sessionChatPort!.listSessions({
    excludeSessionId: String(context.sessionId),
  });
  return SessionListOutputSchema.parse({ sessions }) satisfies SessionListOutput;
};

const sessionTalkHandler: ToolHandler = async (input, context) => {
  const parsed = SessionTalkInputSchema.parse(input) as SessionTalkInput;
  requireSessionChatPort(SESSION_TALK_TOOL_NAME, context.sessionChatPort);
  const ownSessionId = String(context.sessionId);
  if (parsed.targetSessionId === ownSessionId) {
    // 自呼自答只会制造回声；这是入参错误而非投递失败，给稳定原因码。
    return SessionTalkOutputSchema.parse({
      status: "rejected",
      reason: "invalid_target",
      message: "Cannot SessionTalk to the current session.",
    }) satisfies SessionTalkOutput;
  }
  const outcome = await context.sessionChatPort!.talkToSession({
    targetSessionId: parsed.targetSessionId,
    fromSessionId: ownSessionId,
    message: parsed.message,
  });
  if (outcome.kind === "delivered") {
    return SessionTalkOutputSchema.parse({
      status: outcome.queued ? "queued" : "delivered",
      queued: outcome.queued,
    }) satisfies SessionTalkOutput;
  }
  return SessionTalkOutputSchema.parse({
    status: "rejected",
    reason: outcome.reason,
    message: SESSION_TALK_REJECT_MESSAGES[outcome.reason],
  }) satisfies SessionTalkOutput;
};

const SESSION_TALK_REJECT_MESSAGES: Record<string, string> = {
  session_not_found: "Target session not found. Call SessionList for current live sessions.",
  session_busy: "Target session cannot accept input right now. Try again later.",
  invalid_target: "Target session is not chat-accessible from this workspace.",
};

const sessionCreateHandler: ToolHandler = async (input, context) => {
  const parsed = SessionCreateInputSchema.parse(input) as SessionCreateInput;
  requireSessionChatPort(SESSION_CREATE_TOOL_NAME, context.sessionChatPort);
  const result = await context.sessionChatPort!.createCollaboratorSession({
    fromSessionId: String(context.sessionId),
    title: parsed.title,
    ...(parsed.firstMessage === undefined ? {} : { firstMessage: parsed.firstMessage }),
  });
  return SessionCreateOutputSchema.parse({
    status: "created",
    sessionId: result.sessionId,
  }) satisfies SessionCreateOutput;
};

function formatSessionListModelContent(output: unknown): string {
  const parsed = SessionListOutputSchema.safeParse(output);
  if (!parsed.success) return "SessionList returned an invalid result.";
  if (parsed.data.sessions.length === 0) {
    return "No other live sessions in this workspace.";
  }
  const lines = parsed.data.sessions.map(
    (session) => `- ${session.sessionId} [${session.status}] ${session.title || "(untitled)"}`,
  );
  return `Live sessions available for inter-chat:\n${lines.join("\n")}`;
}

function formatSessionTalkModelContent(output: unknown): string {
  const parsed = SessionTalkOutputSchema.safeParse(output);
  if (!parsed.success) return "SessionTalk returned an invalid result.";
  if (parsed.data.status === "delivered") {
    return "Message delivered. The target session's model will process it on its current turn; if it replies, the reply arrives via SessionTalk in a later turn.";
  }
  if (parsed.data.status === "queued") {
    return "Target session is busy; message queued for its next turn. Do not send it again.";
  }
  return parsed.data.message ?? "SessionTalk was rejected.";
}

function formatSessionCreateModelContent(output: unknown): string {
  const parsed = SessionCreateOutputSchema.safeParse(output);
  if (!parsed.success) return "SessionCreate returned an invalid result.";
  if (parsed.data.status === "created" && parsed.data.sessionId) {
    return `Collaborator session created: ${parsed.data.sessionId}. Its model can reach you back via SessionTalk.`;
  }
  return parsed.data.reason ?? "SessionCreate was rejected.";
}

export const sessionListToolEntry: ToolEntry = {
  capability: "List other live sessions in this workspace for inter-chat",
  metadata: {
    name: SESSION_LIST_TOOL_NAME,
    description: SESSION_LIST_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: SESSION_LIST_TIMEOUT_MS,
    maxOutputBytes: MAX_SESSION_CHAT_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: sessionListHandler,
  formatModelContent: formatSessionListModelContent,
  inputSchema: SessionListInputJsonSchema,
  outputSchema: SessionListOutputJsonSchema,
  runtimeInputSchema: SessionListInputSchema,
  runtimeOutputSchema: SessionListOutputSchema,
  permission: {
    permission: "session.chat.read",
    reason: "SessionList reads live session titles and status in this workspace",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_SESSION_CHAT_MODEL_BYTES,
    maxModelBytes: MAX_SESSION_CHAT_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_SESSION_CHAT_MODEL_BYTES, direction: "head" },
  },
  timeout: { defaultMs: SESSION_LIST_TIMEOUT_MS, maxMs: SESSION_LIST_TIMEOUT_MS, allowCallOverride: false },
  cancellation: { supported: true, cleanup: "none", userVisibleMessage: "SessionList was cancelled" },
  trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
};

export const sessionTalkToolEntry: ToolEntry = {
  capability: "Send a message to another session in this workspace (fire-and-return)",
  metadata: {
    name: SESSION_TALK_TOOL_NAME,
    description: SESSION_TALK_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: SESSION_TALK_TIMEOUT_MS,
    maxOutputBytes: MAX_SESSION_CHAT_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: sessionTalkHandler,
  formatModelContent: formatSessionTalkModelContent,
  inputSchema: SessionTalkInputJsonSchema,
  outputSchema: SessionTalkOutputJsonSchema,
  runtimeInputSchema: SessionTalkInputSchema,
  runtimeOutputSchema: SessionTalkOutputSchema,
  permission: {
    permission: "session.chat.talk",
    reason: "SessionTalk injects a marked message into another session in this workspace",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_SESSION_CHAT_MODEL_BYTES,
    maxModelBytes: MAX_SESSION_CHAT_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_SESSION_CHAT_MODEL_BYTES, direction: "head" },
  },
  timeout: { defaultMs: SESSION_TALK_TIMEOUT_MS, maxMs: SESSION_TALK_TIMEOUT_MS, allowCallOverride: false },
  cancellation: { supported: true, cleanup: "none", userVisibleMessage: "SessionTalk was cancelled" },
  trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
};

export const sessionCreateToolEntry: ToolEntry = {
  capability: "Create a collaborator session in this workspace",
  metadata: {
    name: SESSION_CREATE_TOOL_NAME,
    description: SESSION_CREATE_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: SESSION_CREATE_TIMEOUT_MS,
    maxOutputBytes: MAX_SESSION_CHAT_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: sessionCreateHandler,
  formatModelContent: formatSessionCreateModelContent,
  inputSchema: SessionCreateInputJsonSchema,
  outputSchema: SessionCreateOutputJsonSchema,
  runtimeInputSchema: SessionCreateInputSchema,
  runtimeOutputSchema: SessionCreateOutputSchema,
  permission: {
    permission: "session.chat.create",
    reason: "SessionCreate adds a new collaborator session to this workspace",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_SESSION_CHAT_MODEL_BYTES,
    maxModelBytes: MAX_SESSION_CHAT_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_SESSION_CHAT_MODEL_BYTES, direction: "head" },
  },
  timeout: { defaultMs: SESSION_CREATE_TIMEOUT_MS, maxMs: SESSION_CREATE_TIMEOUT_MS, allowCallOverride: false },
  cancellation: { supported: true, cleanup: "none", userVisibleMessage: "SessionCreate was cancelled" },
  trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
};
