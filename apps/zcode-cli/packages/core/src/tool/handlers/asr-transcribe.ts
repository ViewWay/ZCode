// ============================================================
// AsrTranscribe Handler - asr_transcribe（specs/voice/image-tools 规范族）
// ============================================================
// 对齐 MiMo 的 asr_transcribe：音频→文本。源音频经 fileSystemPort 只读
// （沿用 external path 授权边界）；音频内容发送至语音端点（NOTICE.md 已声明）。
// 端口缺席不注册（fail-closed）；走到 handler 遇端口缺席属接线故障。

import {
  CoreErrorType,
  createCoreError,
  ASR_TRANSCRIBE_TOOL_NAME,
  AsrTranscribeInputJsonSchema,
  AsrTranscribeInputSchema,
  AsrTranscribeOutputJsonSchema,
  AsrTranscribeOutputSchema,
  type AsrTranscribeInput,
  type AsrTranscribeOutput,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

/** 语音端点调用默认超时（合成/转写长音频可比图像慢）。 */
export const VOICE_TOOL_TIMEOUT_MS = 300_000;
/** 工具结果回灌模型预算。 */
export const VOICE_TOOL_MODEL_BYTES = 24_000;
/** 转写源音频读取上限（60MB，覆盖常见长音频）。 */
export const ASR_SOURCE_MAX_BYTES = 62_914_560;

/** 语音端口守卫：asr/tts 共用；缺席属接线故障（fail-closed 注册门外第二道）。 */
export function requireVoicePipelinePort(
  context: ToolExecutionContext,
  toolName: string,
): asserts context is ToolExecutionContext & {
  voicePipelinePort: NonNullable<ToolExecutionContext["voicePipelinePort"]>;
} {
  if (context.voicePipelinePort) return;
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `VoicePipelinePort is not configured for ${toolName}`,
    {
      context: { toolName },
      recoverable: false,
    },
  );
}

const ASR_DESCRIPTION = [
  "# asr_transcribe",
  "",
  "Transcribe an audio file to text.",
  "The audio content is sent to the configured speech endpoint.",
].join(" ");

const asrTranscribeHandler: ToolHandler = async (input, context) => {
  const parsed = AsrTranscribeInputSchema.parse(input) as AsrTranscribeInput;
  requireVoicePipelinePort(context, ASR_TRANSCRIBE_TOOL_NAME);
  const fileSystemPort = context.fileSystemPort;
  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for asr_transcribe",
      { context: { toolName: ASR_TRANSCRIBE_TOOL_NAME }, recoverable: false },
    );
  }
  try {
    const source = await fileSystemPort.readBinaryFile(
      {
        path: parsed.file,
        maxBytes: ASR_SOURCE_MAX_BYTES,
        trace: {
          traceId: context.traceId,
          spanId: context.spanId,
          parentSpanId: context.parentSpanId,
          sessionId: context.sessionId,
          turnId: context.turnId,
        } as unknown as TraceContext,
      },
      { signal: context.abortSignal },
    );
    const result = await context.voicePipelinePort.transcribe({
      audioBase64: Buffer.from(source.content).toString("base64"),
      ...(parsed.language ? { language: parsed.language } : {}),
    });
    return AsrTranscribeOutputSchema.parse(result) satisfies AsrTranscribeOutput;
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") throw error;
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      error instanceof Error ? error.message : String(error),
      {
        context: { toolCallId: context.toolCallId, toolName: ASR_TRANSCRIBE_TOOL_NAME },
        recoverable: true,
      },
    );
  }
};

export const asrTranscribeToolEntry: ToolEntry = {
  capability: "Transcribe an audio file to text",
  metadata: {
    name: ASR_TRANSCRIBE_TOOL_NAME,
    description: ASR_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: VOICE_TOOL_TIMEOUT_MS,
    maxOutputBytes: VOICE_TOOL_MODEL_BYTES,
    sideEffectScope: "network",
    riskLevel: "medium",
    needsApproval: false,
  },
  handler: asrTranscribeHandler,
  inputSchema: AsrTranscribeInputJsonSchema,
  outputSchema: AsrTranscribeOutputJsonSchema,
  runtimeInputSchema: AsrTranscribeInputSchema,
  runtimeOutputSchema: AsrTranscribeOutputSchema,
  permission: {
    permission: "voice.transcribe",
    reason: "asr_transcribe sends the audio content to the configured speech endpoint",
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
    userVisibleMessage: "asr_transcribe was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};