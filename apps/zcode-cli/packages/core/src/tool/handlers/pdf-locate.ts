// ============================================================
// PDF Locate Handler - pdf_locate（PDF 预览联动，specs/pdf-preview-linkage.md）
// ============================================================
// 模型回答引用 PDF 原文后调用一次：经 PdfDocumentPort.extractPageTexts 取
// 逐页文本，用纯函数匹配器（src/pdf-locate/matcher.ts）判定 status+page，
// 供预览端滚动定位与高亮。匹配失败不报错，降级为翻页/打开文件（spec 验收
// 场景 2）。端口缺席即不注册（fail-closed）；注册门之外走到 handler 属接线
// 故障（照 get-desktop-setting 的 requireDesktopSettingsPort 模式抛
// ConfigurationError）。只读、无文件副作用（高亮只作用于预览层）。

import {
  CoreErrorType,
  createCoreError,
  PDF_LOCATE_MODEL_BYTES,
  PDF_LOCATE_TIMEOUT_MS,
  PDF_LOCATE_TOOL_DESCRIPTION,
  PDF_LOCATE_TOOL_NAME,
  PdfDocumentPortError,
  PdfLocateInputJsonSchema,
  PdfLocateInputSchema,
  PdfLocateOutputJsonSchema,
  PdfLocateOutputSchema,
  type PdfLocateInput,
  type PdfLocateOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";
import { matchPdfSnippet } from "../../pdf-locate/matcher.js";
import {
  createToolTrace,
  READ_ERROR_CODE_BY_PDF_DOCUMENT_ERROR,
  rethrowPdfCancellation,
} from "./read-pdf.js";

/**
 * 注册门以端口存在为准；走到这里说明接线故障，与 GetDesktopSetting 同款 fail-closed。
 */
export function requirePdfDocumentPort(
  context: ToolExecutionContext,
  toolName: string,
): asserts context is ToolExecutionContext & {
  pdfDocumentPort: NonNullable<ToolExecutionContext["pdfDocumentPort"]>;
} {
  if (context.pdfDocumentPort) return;
  throw createCoreError(CoreErrorType.ConfigurationError, `PdfDocumentPort is not configured for ${toolName}`, {
    context: { toolName },
    recoverable: false,
  });
}

const pdfLocateHandler: ToolHandler = async (input, context) => {
  const parsed = PdfLocateInputSchema.parse(input) as PdfLocateInput;
  requirePdfDocumentPort(context, PDF_LOCATE_TOOL_NAME);
  const trace = createToolTrace(context);

  let pageTexts: string[];
  try {
    pageTexts = await context.pdfDocumentPort.extractPageTexts(
      { filePath: parsed.file, trace },
      { signal: context.abortSignal },
    );
  } catch (error) {
    // 取消转换与错误码穷尽映射与 read-pdf 共用（见 read-pdf.ts 的导出注释）。
    rethrowPdfCancellation(error, context.abortSignal);
    if (error instanceof PdfDocumentPortError) {
      const errorCode = READ_ERROR_CODE_BY_PDF_DOCUMENT_ERROR[error.code];
      if (errorCode === undefined) throw error;
      return { result: false, errorCode, message: error.message };
    }
    throw error;
  }

  const match = matchPdfSnippet(pageTexts, parsed.snippet, parsed.page);
  return PdfLocateOutputSchema.parse(match) satisfies PdfLocateOutput;
};

function formatPdfLocateModelContent(output: unknown): string {
  const parsed = PdfLocateOutputSchema.safeParse(output);
  if (!parsed.success) return "pdf_locate returned an invalid result.";
  const { status, page } = parsed.data;
  if (status === "located") return `pdf_locate: snippet highlighted on page ${page}.`;
  if (status === "page_only") return `pdf_locate: snippet not matched; preview moved to page ${page}.`;
  return `pdf_locate: snippet not matched and no page given; preview opened the file at page ${page}.`;
}

export const pdfLocateToolEntry: ToolEntry = {
  capability: "Locate a quoted PDF snippet in the preview panel",
  metadata: {
    name: PDF_LOCATE_TOOL_NAME,
    description: PDF_LOCATE_TOOL_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: PDF_LOCATE_TIMEOUT_MS,
    maxOutputBytes: PDF_LOCATE_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: pdfLocateHandler,
  formatModelContent: formatPdfLocateModelContent,
  inputSchema: PdfLocateInputJsonSchema,
  outputSchema: PdfLocateOutputJsonSchema,
  runtimeInputSchema: PdfLocateInputSchema,
  runtimeOutputSchema: PdfLocateOutputSchema,
  permission: {
    permission: "pdf.locate",
    reason: "pdf_locate only navigates the preview panel to a page and highlights a snippet",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: PDF_LOCATE_MODEL_BYTES,
    maxModelBytes: PDF_LOCATE_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: PDF_LOCATE_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: PDF_LOCATE_TIMEOUT_MS,
    maxMs: PDF_LOCATE_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "pdf_locate was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
