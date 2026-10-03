// ============================================================
// Session Chat - SessionList / SessionTalk / SessionCreate 工具契约
// ============================================================
// 会话互聊（MiMo 实验室同名功能的 ZCode 落地）：允许模型呼叫同 workspace 内的
// 其它存活会话，并创建协作者会话。desktop 形态默认注入 SessionChatPort
// （AppSettings.sessionChatEnabled 缺省即开启）；CLI/TUI 关闭（宿主不注入），
// core 不注册这三个工具（新建回合无此工具面）。spec：specs/session-chat.md。
// 安全边界：SessionTalk 单条消息长度上限 8_000 字符；目标必须同 workspace；
// 不触碰 agent-teams 状态（与 SendMessage/TeamCreate 是两套机制）。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const SESSION_LIST_TOOL_NAME = "SessionList";
export const SESSION_TALK_TOOL_NAME = "SessionTalk";
export const SESSION_CREATE_TOOL_NAME = "SessionCreate";

/** SessionTalk 单条消息长度上限；与 TeamCreate/escalate 的模型面预算同档。 */
export const SESSION_TALK_MESSAGE_MAX_CHARS = 8_000;
/** 工具入参里 title 的长度上限；对齐 TEAM_NAME_MAX_CHARS 的量级。 */
export const SESSION_TITLE_MAX_CHARS = 64;

const sessionTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(SESSION_TITLE_MAX_CHARS)
  .describe("Short collaborator session title (letters, digits, spaces, '_' or '-')");

// ── SessionList ──────────────────────────────────────────────

export const SessionListInputSchema = z.object({}).strict();
export type SessionListInput = z.infer<typeof SessionListInputSchema>;

export const SessionListOutputSchema = z
  .object({
    sessions: z.array(
      z.object({
        sessionId: z.string(),
        /** 可选：宿主解析不到标题时省略；展示层回退 untitled。 */
        title: z.string().optional(),
        /** busy = 目标会话存在未完成 turn；唯一来源是 SessionChatPort（宿主注册表）。 */
        status: z.enum(["busy", "idle"]),
        updatedAt: z.number(),
      }),
    ),
  })
  .strict();
export type SessionListOutput = z.infer<typeof SessionListOutputSchema>;

export const SessionListInputJsonSchema = toToolJsonSchema(SessionListInputSchema);
export const SessionListOutputJsonSchema = toToolJsonSchema(SessionListOutputSchema);

// ── SessionTalk ──────────────────────────────────────────────

export const SessionTalkInputSchema = z
  .object({
    targetSessionId: z.string().min(1).describe("SessionId from SessionList (not this session)"),
    message: z
      .string()
      .min(1)
      .max(SESSION_TALK_MESSAGE_MAX_CHARS)
      .describe(
        "Self-contained message for the target session's model. The target session sees it " +
          "marked as coming from another session; it can reply by calling SessionTalk back " +
          "with your sessionId. Do not assume the target knows your conversation context.",
      ),
  })
  .strict();
export type SessionTalkInput = z.infer<typeof SessionTalkInputSchema>;

export const SessionTalkOutputSchema = z
  .object({
    status: z.enum(["delivered", "queued", "rejected"]),
    /** delivered 且目标忙时为 true：消息已排队到目标会话的下一轮。 */
    queued: z.boolean().optional(),
    /** rejected 时的稳定原因码。 */
    reason: z.enum(["session_not_found", "session_busy", "invalid_target"]).optional(),
    message: z.string().optional(),
  })
  .strict();
export type SessionTalkOutput = z.infer<typeof SessionTalkOutputSchema>;

export const SessionTalkInputJsonSchema = toToolJsonSchema(SessionTalkInputSchema);
export const SessionTalkOutputJsonSchema = toToolJsonSchema(SessionTalkOutputSchema);

// ── SessionCreate ────────────────────────────────────────────

export const SessionCreateInputSchema = z
  .object({
    title: sessionTitleSchema.describe("Title of the collaborator session"),
    firstMessage: z
      .string()
      .min(1)
      .max(SESSION_TALK_MESSAGE_MAX_CHARS)
      .optional()
      .describe(
        "Optional first message for the collaborator; omit to create an idle session " +
          "the user can open and prompt directly.",
      ),
  })
  .strict();
export type SessionCreateInput = z.infer<typeof SessionCreateInputSchema>;

export const SessionCreateOutputSchema = z
  .object({
    status: z.enum(["created", "rejected"]),
    sessionId: z.string().optional(),
    reason: z.string().optional(),
  })
  .strict();
export type SessionCreateOutput = z.infer<typeof SessionCreateOutputSchema>;

export const SessionCreateInputJsonSchema = toToolJsonSchema(SessionCreateInputSchema);
export const SessionCreateOutputJsonSchema = toToolJsonSchema(SessionCreateOutputSchema);
