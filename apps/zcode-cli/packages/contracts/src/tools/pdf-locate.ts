// ============================================================
// PDF Locate Tool - pdf_locate 工具契约（specs/pdf-preview-linkage.md）
// ============================================================
// 对齐 MiMo 的 pdf_locate：模型回答引用 PDF 原文后调用一次，桌面预览滚动到
// 对应页并高亮片段。status 三态由 core 侧可计算的事实决定：
// - located     ：snippet 在某页文本中匹配成功（精确或归一化空白）；
// - page_only   ：snippet 匹配失败，但入参 page 落在文档页数内，降级仅翻页；
// - file_opened ：snippet 匹配失败且无可用页码，仅打开文件（首页）。
// 渲染端「文件此前是否已打开」在 v1 工具面不可观测，由后续 UI 链路细化。
// 高亮层只作用于预览，不修改 PDF 文件本身（对齐 MiMo "no effect on the file"）。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const PDF_LOCATE_TOOL_NAME = "pdf_locate";

/** 回包只有 status+page，一档紧凑上限即可。 */
export const PDF_LOCATE_MODEL_BYTES = 2_048;
/** 工具级预算：一次 pdftotext 全文提取加匹配（子进程预算见 READ_PDF_TEXT_TIMEOUT_MS）。 */
export const PDF_LOCATE_TIMEOUT_MS = 40_000;

export const PdfLocateStatusSchema = z.enum(["located", "page_only", "file_opened"]);
export type PdfLocateStatus = z.infer<typeof PdfLocateStatusSchema>;

export const PdfLocateInputSchema = z
  .object({
    file: z
      .string()
      .min(1)
      .describe("Absolute path of the PDF file the answer quotes from"),
    snippet: z
      .string()
      .min(1)
      .describe("Verbatim text quoted from the PDF (do not paraphrase or translate)"),
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("1-indexed page number seen while reading this PDF"),
  })
  .strict();
export type PdfLocateInput = z.infer<typeof PdfLocateInputSchema>;

export const PdfLocateOutputSchema = z
  .object({
    status: PdfLocateStatusSchema.describe(
      "located = snippet matched and highlighted; page_only = snippet not matched, preview moved to page; file_opened = snippet not matched and no page given, preview opened the file",
    ),
    page: z.number().int().min(1).describe("1-indexed page the preview should show"),
  })
  .strict();
export type PdfLocateOutput = z.infer<typeof PdfLocateOutputSchema>;

export const PdfLocateInputJsonSchema = toToolJsonSchema(PdfLocateInputSchema);
export const PdfLocateOutputJsonSchema = toToolJsonSchema(PdfLocateOutputSchema);

/** 工具描述：语义约束（调用时机、snippet 逐字、非 PDF 不调用）随契约走，供 handler 与注册侧共用。 */
export const PDF_LOCATE_TOOL_DESCRIPTION = [
  "# pdf_locate",
  "",
  "Locate a quoted PDF snippet in the preview panel: scroll to the matching page and highlight it.",
  "",
  "Call this exactly once after answering with text quoted from a PDF you read.",
  "`snippet` must be copied verbatim from the PDF content (whitespace differences are tolerated; paraphrasing is not).",
  "Pass `page` as the page number you were reading when quoting, if known; when the snippet cannot be matched, the preview falls back to jumping to that page.",
  "Do not call this tool for non-PDF files.",
].join("\n");
