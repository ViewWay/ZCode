// ============================================================
// External Sessions - list_external_sessions / read_external_session 工具契约
// ============================================================
// 外部会话只读互操作（specs/external-sessions.md，对齐 MiMo 同名功能）：
// 让模型发现并只读访问本机 Claude Code 的历史会话 transcript
// （~/.claude/projects/<项目目录slug>/*.jsonl）。严格只读：任何情况下不写
// Claude Code 目录，不删除、不迁移其数据。
// 隐私边界：transcript 可能含敏感路径、参数与凭据，工具描述携带隐私警示，
// 内容是否引用由模型自行判断。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const LIST_EXTERNAL_SESSIONS_TOOL_NAME = "list_external_sessions";
export const READ_EXTERNAL_SESSION_TOOL_NAME = "read_external_session";

/** 列表与读取输出中 title 的截断长度：summary 行或首条用户消息截断到该长度。 */
export const EXTERNAL_SESSION_TITLE_MAX_CHARS = 80;

// ── list_external_sessions ───────────────────────────────────

export const ListExternalSessionsInputSchema = z
  .object({
    projectPath: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional absolute project path filter (e.g. /Users/me/work/my-app); " +
          "only sessions whose working directory matches are listed",
      ),
  })
  .strict();
export type ListExternalSessionsInput = z.infer<typeof ListExternalSessionsInputSchema>;

export const ExternalSessionSummarySchema = z
  .object({
    sessionId: z.string().min(1),
    title: z.string().optional(),
    projectPath: z.string(),
    /** 首条消息时间戳（epoch ms）；transcript 无时间戳时省略。 */
    startedAt: z.number().optional(),
    /** 末条消息时间戳（epoch ms）；缺失时回退文件 mtime。 */
    lastUpdatedAt: z.number(),
    messageCount: z.number().int().min(0),
  })
  .strict();
export type ExternalSessionSummary = z.infer<typeof ExternalSessionSummarySchema>;

export const ListExternalSessionsOutputSchema = z
  .object({
    sessions: z.array(ExternalSessionSummarySchema),
  })
  .strict();
export type ListExternalSessionsOutput = z.infer<typeof ListExternalSessionsOutputSchema>;

export const ListExternalSessionsInputJsonSchema = toToolJsonSchema(
  ListExternalSessionsInputSchema,
);
export const ListExternalSessionsOutputJsonSchema = toToolJsonSchema(
  ListExternalSessionsOutputSchema,
);

// ── read_external_session ────────────────────────────────────

export const ReadExternalSessionInputSchema = z
  .object({
    sessionId: z.string().min(1).describe("Session id from list_external_sessions"),
  })
  .strict();
export type ReadExternalSessionInput = z.infer<typeof ReadExternalSessionInputSchema>;

export const ExternalSessionMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    timestamp: z.number().optional(),
  })
  .strict();
export type ExternalSessionMessage = z.infer<typeof ExternalSessionMessageSchema>;

export const ReadExternalSessionOutputSchema = z
  .object({
    sessionId: z.string().min(1),
    title: z.string().optional(),
    projectPath: z.string(),
    messages: z.array(ExternalSessionMessageSchema),
    messageCount: z.number().int().min(0),
    /** 解析中被跳过行的聚合说明（未知 type / 损坏行计数），无跳过时省略。 */
    warnings: z.array(z.string()).optional(),
  })
  .strict();
export type ReadExternalSessionOutput = z.infer<typeof ReadExternalSessionOutputSchema>;

export const ReadExternalSessionInputJsonSchema = toToolJsonSchema(ReadExternalSessionInputSchema);
export const ReadExternalSessionOutputJsonSchema = toToolJsonSchema(
  ReadExternalSessionOutputSchema,
);
