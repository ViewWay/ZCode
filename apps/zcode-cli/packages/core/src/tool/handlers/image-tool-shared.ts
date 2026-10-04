// ============================================================
// Image Tools Shared - image_gen/image_edit 共用守卫与落盘（specs/image-tools.md）
// ============================================================
// 端口缺席走到 handler 属接线故障（照 DesktopSettings 守卫抛 ConfigurationError）。
// 产物落盘经 ToolArtifactStorePort 二进制通道（唯一落盘点），handler 只回
// 绝对路径与尺寸；store 不支持二进制时按可读工具失败处理（recoverable）。

import {
  CoreErrorType,
  createCoreError,
  IMAGE_GEN_TOOL_NAME,
  type ImageGenerationPort,
} from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";

/** 生成/编辑端点调用的默认超时。 */
export const IMAGE_TOOL_TIMEOUT_MS = 180_000;
/** 工具结果回灌模型的字节预算（路径+尺寸信息很小，取小值）。 */
export const IMAGE_TOOL_MODEL_BYTES = 24_000;
/** 编辑模式源图读取上限（与 read-image 输入上限同量级）。 */
export const IMAGE_EDIT_SOURCE_MAX_BYTES = 10_485_760;

export function requireImageGenerationPort(
  context: ToolExecutionContext,
  toolName: string,
): asserts context is ToolExecutionContext & {
  imageGenerationPort: NonNullable<ToolExecutionContext["imageGenerationPort"]>;
} {
  if (context.imageGenerationPort) return;
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `ImageGenerationPort is not configured for ${toolName}`,
    {
      context: { toolName },
      recoverable: false,
    },
  );
}

function mimeToExtension(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "bin";
}

/** 生成/编辑结果落盘 artifacts：base64→二进制 artifact，回绝对路径与尺寸。 */
export async function persistImageArtifact(
  context: ToolExecutionContext,
  toolName: string,
  result: { dataBase64: string; mimeType: string; width?: number; height?: number },
): Promise<{ file: string; width?: number; height?: number }> {
  const store = context.artifactStore;
  if (!store?.writeToolResultBinaryArtifact) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "当前宿主的 artifact 存储不支持二进制产物落盘",
      {
        context: { code: "image_artifact_binary_unsupported", toolCallId: context.toolCallId, toolName },
        recoverable: true,
      },
    );
  }
  const written = await store.writeToolResultBinaryArtifact(
    {
      sessionId: context.sessionId,
      ...(context.turnId ? { turnId: context.turnId } : {}),
      toolCallId: context.toolCallId,
      toolName,
      content: Buffer.from(result.dataBase64, "base64"),
      contentType: result.mimeType,
      extension: mimeToExtension(result.mimeType),
      retention: "session",
    },
    { signal: context.abortSignal },
  );
  return {
    file: requireArtifactPath(written, context.toolCallId, toolName),
    ...(result.width !== undefined ? { width: result.width } : {}),
    ...(result.height !== undefined ? { height: result.height } : {}),
  };
}

function requireArtifactPath(
  written: { path?: string },
  toolCallId: string,
  toolName: string,
): string {
  if (!written.path) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "artifact 存储未返回落盘路径",
      {
        context: { code: "image_artifact_missing_path", toolCallId, toolName },
        recoverable: true,
      },
    );
  }
  return written.path;
}
