// ============================================================
// ImageGen Handler - image_gen（specs/image-tools.md）
// ============================================================
// 对齐 MiMo 的 image_gen：文生图。网络副作用：提示词发送至图像端点
// （NOTICE.md 第二节已声明）。端口缺席不注册（fail-closed）。

import {
  CoreErrorType,
  createCoreError,
  IMAGE_GEN_TOOL_NAME,
  IMAGE_TOOL_PATH_NOTE,
  ImageGenInputJsonSchema,
  ImageGenInputSchema,
  ImageGenOutputJsonSchema,
  ImageToolOutputSchema,
  type ImageGenInput,
  type ImageToolOutput,
} from "@zcode/contracts";
import {
  IMAGE_TOOL_MODEL_BYTES,
  IMAGE_TOOL_TIMEOUT_MS,
  persistImageArtifact,
  requireImageGenerationPort,
} from "./image-tool-shared.js";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const IMAGE_GEN_DESCRIPTION = [
  "# image_gen",
  "",
  "Generate an image from a text prompt. The result file path is returned;",
  IMAGE_TOOL_PATH_NOTE,
].join(" ");

const imageGenHandler: ToolHandler = async (input, context) => {
  const parsed = ImageGenInputSchema.parse(input) as ImageGenInput;
  requireImageGenerationPort(context, IMAGE_GEN_TOOL_NAME);
  try {
    const result = await context.imageGenerationPort.generateImage({
      prompt: parsed.prompt,
      ...(parsed.size ? { size: parsed.size } : {}),
    });
    return ImageToolOutputSchema.parse(
      await persistImageArtifact(context, IMAGE_GEN_TOOL_NAME, result),
    ) satisfies ImageToolOutput;
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") throw error;
    // 端点未配置/端点错误统一映射为可读工具失败（spec 验收 3：指引配置图像模型）。
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      error instanceof Error ? error.message : String(error),
      {
        context: { toolCallId: context.toolCallId, toolName: IMAGE_GEN_TOOL_NAME },
        recoverable: true,
      },
    );
  }
};

export const imageGenToolEntry: ToolEntry = {
  capability: "Generate an image from a text prompt",
  metadata: {
    name: IMAGE_GEN_TOOL_NAME,
    description: IMAGE_GEN_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: IMAGE_TOOL_TIMEOUT_MS,
    maxOutputBytes: IMAGE_TOOL_MODEL_BYTES,
    sideEffectScope: "network",
    riskLevel: "medium",
    needsApproval: false,
  },
  handler: imageGenHandler,
  inputSchema: ImageGenInputJsonSchema,
  outputSchema: ImageGenOutputJsonSchema,
  runtimeInputSchema: ImageGenInputSchema,
  runtimeOutputSchema: ImageToolOutputSchema,
  permission: {
    permission: "image.generate",
    reason: "image_gen sends the prompt to the configured image endpoint",
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
    userVisibleMessage: "image_gen was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
