// ============================================================
// Voice Tools - asr_transcribe / tts_speech 工具契约（specs/voice-pipeline.md）
// ============================================================
// 对齐 MiMo 的 asr_transcribe / tts_speech：音频→文本、文本→音频。
// 网络副作用：音频内容/待读文本发送至语音端点（NOTICE.md 第二节已声明）。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const ASR_TRANSCRIBE_TOOL_NAME = "asr_transcribe";
export const TTS_SPEECH_TOOL_NAME = "tts_speech";

// ── asr_transcribe ───────────────────────────────────────────

export const AsrTranscribeInputSchema = z
  .object({
    file: z.string().min(1).describe("Absolute path of the audio file to transcribe"),
    language: z.string().optional().describe('Language hint like "zh-CN"'),
  })
  .strict();
export type AsrTranscribeInput = z.infer<typeof AsrTranscribeInputSchema>;

export const AsrTranscribeOutputSchema = z
  .object({
    text: z.string(),
    durationMs: z.number().optional(),
    language: z.string().optional(),
  })
  .strict();
export type AsrTranscribeOutput = z.infer<typeof AsrTranscribeOutputSchema>;

export const AsrTranscribeInputJsonSchema = toToolJsonSchema(AsrTranscribeInputSchema);
export const AsrTranscribeOutputJsonSchema = toToolJsonSchema(AsrTranscribeOutputSchema);

// ── tts_speech ───────────────────────────────────────────────

export const TtsSpeechInputSchema = z
  .object({
    text: z.string().min(1).describe("The text to read aloud"),
    voice: z.string().optional().describe("Endpoint-side voice id"),
    output_path: z.string().optional().describe("Workspace-relative output file name"),
  })
  .strict();
export type TtsSpeechInput = z.infer<typeof TtsSpeechInputSchema>;

export const TtsSpeechOutputSchema = z
  .object({
    file: z.string().describe("Absolute path of the synthesized audio file"),
    durationMs: z.number().optional(),
  })
  .strict();
export type TtsSpeechOutput = z.infer<typeof TtsSpeechOutputSchema>;
export const TtsSpeechInputJsonSchema = toToolJsonSchema(TtsSpeechInputSchema);
export const TtsSpeechOutputJsonSchema = toToolJsonSchema(TtsSpeechOutputSchema);
