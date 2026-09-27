import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const SEND_MESSAGE_TOOL_NAME = "SendMessage";
export const SEND_MESSAGE_MAX_CONTENT_CHARS = 20_000;

export const SendMessageInputSchema = z
  .object({
    to: z
      .string()
      .min(1)
      .max(200)
      .describe("Recipient: local agent ID returned by Agent (format agent_<uuid>)."),
    summary: z
      .string()
      .min(1)
      .max(200)
      .describe("A 5-10 word summary shown as a preview in the UI."),
    message: z
      .string()
      .min(1)
      .max(SEND_MESSAGE_MAX_CONTENT_CHARS)
      .describe("Plain text message content"),
  })
  .strict();

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export const SendMessageInputJsonSchema = toToolJsonSchema(SendMessageInputSchema);

export const SendMessageOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    messageId: z.string(),
    agentId: z.string().optional(),
    delivery: z.enum(["queued", "steered", "resumed_background", "teammate_mailbox"]).optional(),
    error: z.string().optional(),
    message: z.string().optional(),
    outputFile: z.string().optional(),
    taskId: z.string().optional(),
    // Agent Teams（specs/agent-teams.md）：队友邮箱路由的投递事实，UI timeline 展示用。
    teammate: z.string().optional(),
    broadcastTo: z.array(z.string()).optional(),
    broadcastFailures: z
      .array(z.object({ member: z.string(), error: z.string() }).strict())
      .optional(),
  })
  .strict();

export type SendMessageOutput = z.infer<typeof SendMessageOutputSchema>;

export const SendMessageOutputJsonSchema = toToolJsonSchema(SendMessageOutputSchema);
