// ============================================================
// Present Files - present_files 工具契约（交付物卡片）
// ============================================================
// specs/deliverable-cards.md：模型用本工具声明"交付物/用户想保留或查看的文件"，
// UI 据此渲染可点击卡片并联动预览。本工具是纯声明面：
// - 不做任何文件操作（不读写、不校验存在性——卡片侧有 stat 校验兜底）；
// - 只对最终交付物调用；中间产物、仅读过的依赖文件不调用；
// - 交互演示类需求改用 ```zwidget 围栏回复，不生成临时文件再声明。
// 工具名常量（PRESENT_FILES_TOOL_NAME）来自 @zcode/shared/zwidget：
// UI 消息流按同一名字认领卡片 renderer，两侧不允许各写一份字符串。

import { z } from "zod";
import { PRESENT_FILES_TOOL_NAME } from "@zcode/shared";
import { toToolJsonSchema } from "./json-schema.js";

// 工具名随本契约面一并再导出：core/executor 经 @zcode/contracts 取名时与
// shared 单一事实源保持一致（external-session 等契约的同款表面）。
export { PRESENT_FILES_TOOL_NAME };

/** 单次最多声明的交付物数量：卡片流按"少而准"设计，超量在入参层即被拒。 */
export const PRESENT_FILES_MAX_FILES = 20;
/** note 的长度上限（字符）：一句话备注，不承载正文。 */
export const PRESENT_FILES_NOTE_MAX_CHARS = 500;
/** 回包回灌预算：输出是路径回显，给一档宽松上限。 */
export const PRESENT_FILES_MODEL_BYTES = 8_192;
/** 纯声明无 IO，超时只是防御性上界。 */
export const PRESENT_FILES_TIMEOUT_MS = 5_000;

export const PresentFilesInputSchema = z
  .object({
    files: z
      .array(z.string().min(1).max(4_096))
      .min(1)
      .max(PRESENT_FILES_MAX_FILES)
      .describe(
        "Absolute paths of deliverable files the user should keep or review " +
          "(reports, generated documents, exports, final artifacts)",
      ),
    note: z
      .string()
      .max(PRESENT_FILES_NOTE_MAX_CHARS)
      .optional()
      .describe("One-line note about these deliverables, shown next to the cards"),
  })
  .strict();
export type PresentFilesInput = z.infer<typeof PresentFilesInputSchema>;

export const PresentFilesOutputSchema = z
  .object({
    /** 与输入一致的路径回显（去重保序）；handler 不做存在性校验。 */
    accepted: z.array(z.string().min(1)),
  })
  .strict();
export type PresentFilesOutput = z.infer<typeof PresentFilesOutputSchema>;

export const PresentFilesInputJsonSchema = toToolJsonSchema(PresentFilesInputSchema);
export const PresentFilesOutputJsonSchema = toToolJsonSchema(PresentFilesOutputSchema);
