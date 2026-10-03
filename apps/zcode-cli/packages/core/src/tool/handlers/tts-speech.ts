// ============================================================
// TtsSpeech Handler - tts_speech（specs/voice-pipeline.md）
// ============================================================
// 对齐 MiMo 的 tts_speech：文本→音频。产物经 ToolArtifactStorePort 落盘
// 会话 artifacts（唯一落盘点），handler 回绝对路径；模型需把路径告知用户。

import {
  CoreErrorType,
  createCoreError,
  TTS_SPEECH_TOOL_NAME,
  TtsSpeechInputJsonSchema,
  TtsSpeechInputSchema,
  TtsSpeechOutputJsonSchema,
  TtsSpeechOutputSchema,
  type TtsSpeechInput,
  type TtsSpeechOutput,
} from "@zcode/contracts";
import {
  VOICE_TOOL_MODEL_BYTES,
  VOICE_TOOL_TIMEOUT_MS,
  requireVoicePipelinePort,
} from "./asr-transcribe.js";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const TTS_DESCRIPTION = [
  "# tts_speech",
  "",
  "Synthesize speech audio from text.",
  "The text is sent to the configured speech endpoint;",
  "tell the user the generated audio file path.",
].join(" ");

function mimeToExtension(mimeType: string): string {
  if (mimeType === "audio/mpeg") return "mp3";
  if (mimeType === "audio/wav" || mimeType === "audio/x-wav") return "wav";
  if (mimeType === "audio/ogg") return "ogg";
  return "bin";
}

const ttsSpeechHandler: ToolHandler = async (input, context) => {
  const parsed = TtsSpeechInputSchema.parse(input) as TtsSpeechInput;
  requireVoicePipelinePort(context, TTS_SPEECH_TOOL_NAME);
  try {
    const result = await context.voicePipelinePort.synthesize({
      text: parsed.text,
      ...(parsed.voice ? { voice: parsed.voice } : {}),
    });
    const store = context.artifactStore;
    if (!store?.writeToolResultBinaryArtifact) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        "当前宿主的 artifact 存储不支持二进制产物落盘",
        {
          context: { code: "tts_artifact_binary_unsupported", toolCallId: context.toolCallId, toolName: TTS_SPEECH_TOOL_NAME },
          recoverable: true,
        },
      );
    }
    const written = await store.writeToolResultBinaryArtifact(
      {
        sessionId: context.sessionId,
        ...(context.turnId ? { turnId: context.turnId } : {}),
        toolCallId: context.toolCallId,
        toolName: TTS_SPEECH_TOOL_NAME,
        content: Buffer.from(result.audioBase64, "base64"),
        contentType: result.mimeType,
        extension: mimeToExtension(result.mimeType),
        retention: "session",
      },
      { signal: context.abortSignal },
    );
    if (!written.path) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        "artifact 存储未返回落盘路径",
        {
          context: { code: "tts_artifact_missing_path", toolCallId: context.toolCallId, toolName: TTS_SPEECH_TOOL_NAME },
          recoverable: true,
        },
      );
    }
    return TtsSpeechOutputSchema.parse({
      file: written.path,
      ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    }) satisfies TtsSpeechOutput;
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") throw error;
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      error instanceof Error ? error.message : String(error),
      {
        context: { toolCallId: context.toolCallId, toolName: TTS_SPEECH_TOOL_NAME },
        recoverable: true,
      },
    );
  }
};

export const ttsSpeechToolEntry: ToolEntry = {
  capability: "Synthesize speech audio from text",
  metadata: {
    name: TTS_SPEECH_TOOL_NAME,
    description: TTS_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: VOICE_TOOL_TIMEOUT_MS,
    maxOutputBytes: VOICE_TOOL_MODEL_BYTES,
    sideEffectScope: "network",
    riskLevel: "medium",
    needsApproval: false,
  },
  handler: ttsSpeechHandler,
  inputSchema: TtsSpeechInputJsonSchema,
  outputSchema: TtsSpeechOutputJsonSchema,
  runtimeInputSchema: TtsSpeechInputSchema,
  runtimeOutputSchema: TtsSpeechOutputSchema,
  permission: {
    permission: "voice.synthesize",
    reason: "tts_speech sends the text to the configured speech endpoint",
    riskLevel: "medium",
    sideEffectScope: "network",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: VOICE_TOOL_MODEL_BYTES,
    maxModelBytes: VOICE_TOOL_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: VOICE_TOOL_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: VOICE_TOOL_TIMEOUT_MS,
    maxMs: VOICE_TOOL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "tts_speech was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
