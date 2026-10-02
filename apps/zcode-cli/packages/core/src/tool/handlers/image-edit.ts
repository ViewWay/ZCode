// ============================================================
// ImageEdit Handler - image_edit（specs/image-tools.md）
// ============================================================
// 对齐 MiMo 语义：图生图/局部编辑。源图经 fileSystemPort 只读（沿用既有
// external path 授权边界），编辑结果写为新文件、不覆盖原图。网络副作用：
// 提示词与源图发送至图像端点（NOTICE.md 第二节已声明）。

import {
  CoreErrorType,
  createCoreError,
  IMAGE_EDIT_TOOL_NAME,
  IMAGE_TOOL_PATH_NOTE,
  ImageEditInputJsonSchema,
  ImageEditInputSchema,
  ImageEditOutputJsonSchema,
  ImageToolOutputSchema,
  type ImageEditInput,
  type ImageToolOutput,
  type TraceContext,
} from "@zcode/contracts";
import { inferImageMimeFromPath } from "./read-image.js";
import {
  IMAGE_EDIT_SOURCE_MAX_BYTES,
  IMAGE_TOOL_MODEL_BYTES,
  IMAGE_TOOL_TIMEOUT_MS,
  persistImageArtifact,
  requireImageGenerationPort,
} from "./image-tool-shared.js";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const IMAGE_EDIT_DESCRIPTION = [
  "# image_edit",
  "",
  "Edit an existing image with a text instruction.",
  "Reads the source image read-only; the edit result is written as a NEW file",
  "(the source image is never overwritten).",
  IMAGE_TOOL_PATH_NOTE,
].join(" ");

const imageEditHandler: ToolHandler = async (input, context) => {
  const parsed = ImageEditInputSchema.parse(input) as ImageEditInput;
  requireImageGenerationPort(context, IMAGE_EDIT_TOOL_NAME);
  const fileSystemPort = context.fileSystemPort;
  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for image_edit",
      { context: { toolName: IMAGE_EDIT_TOOL_NAME }, recoverable: false },
    );
  }
  try {
    // 源图只读：fileSystemPort 自带 external path 授权边界（工作区外路径照既有规则）。
    const source = await fileSystemPort.readBinaryFile(
      {
        path: parsed.file,
        maxBytes: IMAGE_EDIT_SOURCE_MAX_BYTES,
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
    const result = await context.imageGenerationPort.editImage({
      prompt: parsed.prompt,
      imageBase64: Buffer.from(source.content).toString("base64"),
      imageMimeType: inferImageMimeFromPath(parsed.file),
      ...(parsed.size ? { size: parsed.size } : {}),
    });
    return ImageToolOutputSchema.parse(
      await persistImageArtifact(context, IMAGE_EDIT_TOOL_NAME, result),
    ) satisfies ImageToolOutput;
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") throw error;
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      error instanceof Error ? error.message : String(error),
      {
        context: { toolCallId: context.toolCallId, toolName: IMAGE_EDIT_TOOL_NAME },
        recoverable: true,
      },
    );
  }
};

export const imageEditToolEntry: ToolEntry = {
  capability: "Edit an existing image with a text instruction",
  metadata: {
    name: IMAGE_EDIT_TOOL_NAME,
    description: IMAGE_EDIT_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: IMAGE_TOOL_TIMEOUT_MS,
    maxOutputBytes: IMAGE_TOOL_MODEL_BYTES,
    sideEffectScope: "network",
    riskLevel: "medium",
    needsApproval: false,
  },
  handler: imageEditHandler,
  inputSchema: ImageEditInputJsonSchema,
  outputSchema: ImageEditOutputJsonSchema,
  runtimeInputSchema: ImageEditInputSchema,
  runtimeOutputSchema: ImageToolOutputSchema,
  permission: {
    permission: "image.edit",
    reason: "image_edit sends the prompt and source image to the configured image endpoint",
    riskLevel: "medium",
    sideEffectScope: "network",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: IMAGE_TOOL_MODEL_BYTES,
    maxModelBytes: IMAGE_TOOL_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: IMAGE_TOOL_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: IMAGE_TOOL_TIMEOUT_MS,
    maxMs: IMAGE_TOOL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "image_edit was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
