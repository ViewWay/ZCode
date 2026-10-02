// ============================================================
// Image Tools - image_gen / image_edit 工具契约（specs/image-tools.md）
// ============================================================
// 对齐 MiMo 的 image_gen / image_edit：模型可生成与编辑图片，产物经
// ToolArtifactStorePort 落盘会话 artifacts，handler 回绝对路径与尺寸。
// 网络副作用声明：提示词与参考图会发送至图像服务端点（NOTICE.md 已声明）。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const IMAGE_GEN_TOOL_NAME = "image_gen";
export const IMAGE_EDIT_TOOL_NAME = "image_edit";

/** 生成/编辑回复中要求模型告知用户的路径提示。 */
export const IMAGE_TOOL_PATH_NOTE =
  "Tell the user the generated file path; do not call this for intermediate artifacts.";

// ── image_gen ────────────────────────────────────────────────

export const ImageGenInputSchema = z
  .object({
    prompt: z.string().min(1).describe("What to draw (the visual description)"),
    size: z.string().optional().describe('Optional size hint like "1024x1024"'),
  })
  .strict();
export type ImageGenInput = z.infer<typeof ImageGenInputSchema>;

export const ImageToolOutputSchema = z
  .object({
    file: z.string().describe("Absolute path of the generated/edited image"),
    width: z.number().optional(),
    height: z.number().optional(),
  })
  .strict();
export type ImageToolOutput = z.infer<typeof ImageToolOutputSchema>;

export const ImageGenInputJsonSchema = toToolJsonSchema(ImageGenInputSchema);
export const ImageGenOutputJsonSchema = toToolJsonSchema(ImageToolOutputSchema);

// ── image_edit ───────────────────────────────────────────────

export const ImageEditInputSchema = z
  .object({
    file: z.string().min(1).describe("Absolute path of the source image (inside workspace)"),
    prompt: z.string().min(1).describe("The edit instruction"),
    size: z.string().optional().describe('Optional size hint like "1024x1024"'),
  })
  .strict();
export type ImageEditInput = z.infer<typeof ImageEditInputSchema>;

export const ImageEditInputJsonSchema = toToolJsonSchema(ImageEditInputSchema);
export const ImageEditOutputJsonSchema = toToolJsonSchema(ImageToolOutputSchema);
