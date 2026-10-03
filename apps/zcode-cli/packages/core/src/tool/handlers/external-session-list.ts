// ============================================================
// External Sessions - list_external_sessions 工具 handler
// ============================================================
// 外部会话只读互操作（specs/external-sessions.md）：列出本机 Claude Code
// 历史会话元数据。只读 ~/.claude/projects（工具内部白名单，仅读），
// 端口无关、无 gate；无缓存无持久化，每次实时读盘。
// 逻辑主体在 core/src/external-sessions/（与 tool 解耦），本文件只做
// 契约校验、委托与模型面格式化。

import {
  LIST_EXTERNAL_SESSIONS_TOOL_NAME,
  ListExternalSessionsInputJsonSchema,
  ListExternalSessionsInputSchema,
  ListExternalSessionsOutputJsonSchema,
  ListExternalSessionsOutputSchema,
  type ListExternalSessionsInput,
  type ListExternalSessionsOutput,
} from "@zcode/contracts";
import { listExternalSessions } from "../../external-sessions/index.js";
import { LIST_EXTERNAL_SESSIONS_DESCRIPTION } from "./external-session-descriptions.js";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_LIST_MODEL_BYTES = 32_768;
// list 全量读盘解析（无缓存是 v1 的明确决定），比 SessionList 的 10s 放宽。
const LIST_TIMEOUT_MS = 30_000;

const externalSessionListHandler: ToolHandler = async (input) => {
  const parsed = ListExternalSessionsInputSchema.parse(input) as ListExternalSessionsInput;
  const sessions = await listExternalSessions(parsed);
  return ListExternalSessionsOutputSchema.parse({ sessions }) satisfies ListExternalSessionsOutput;
};

function formatListModelContent(output: unknown): string {
  const parsed = ListExternalSessionsOutputSchema.safeParse(output);
  if (!parsed.success) return "list_external_sessions returned an invalid result.";
  if (parsed.data.sessions.length === 0) {
    return "No Claude Code sessions found on this machine (or none matched projectPath).";
  }
  const lines = parsed.data.sessions.map((session) => {
    const title = session.title === undefined ? "(untitled)" : session.title;
    const started = session.startedAt === undefined ? "" : `, started ${session.startedAt}`;
    return `- ${session.sessionId} [${session.messageCount} msgs${started}] ${title} (${session.projectPath})`;
  });
  return `Claude Code sessions (newest first):\n${lines.join("\n")}`;
}

export const listExternalSessionsToolEntry: ToolEntry = {
  capability: "List historical Claude Code sessions on this machine without modifying their data",
  metadata: {
    name: LIST_EXTERNAL_SESSIONS_TOOL_NAME,
    description: LIST_EXTERNAL_SESSIONS_DESCRIPTION,
    modelInstructions: [
      "Use when the user asks to continue, review or recover work from a previous Claude Code session.",
      "Pick a session by recency or title, then call read_external_session with its sessionId.",
      "Only metadata is returned here; contents stay unread until read_external_session is called.",
    ],
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: LIST_TIMEOUT_MS,
    maxOutputBytes: MAX_LIST_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: externalSessionListHandler,
  formatModelContent: formatListModelContent,
  inputSchema: ListExternalSessionsInputJsonSchema,
  outputSchema: ListExternalSessionsOutputJsonSchema,
  runtimeInputSchema: ListExternalSessionsInputSchema,
  runtimeOutputSchema: ListExternalSessionsOutputSchema,
  permission: {
    permission: "external.session.read",
    reason: "list_external_sessions only reads session metadata under ~/.claude/projects",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_LIST_MODEL_BYTES,
    maxModelBytes: MAX_LIST_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_LIST_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: LIST_TIMEOUT_MS,
    maxMs: LIST_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "list_external_sessions was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
