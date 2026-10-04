import type { TraceContext } from "../tracing/tracer.js";

export interface PdfDocumentPageCountRequest {
  filePath: string;
  trace: TraceContext;
}

export interface PdfDocumentRenderPagesRequest extends PdfDocumentPageCountRequest {
  firstPage: number;
  lastPage: number;
}

export interface PdfDocumentRenderedPage {
  data: Uint8Array;
  mediaType: "image/jpeg";
  pageNumber: number;
}

export type PdfDocumentErrorCode =
  | "cancelled"
  | "corrupted"
  | "io_error"
  | "page_out_of_range"
  | "password_protected"
  | "permission_denied"
  | "process_failed"
  | "timeout"
  | "unavailable";

export class PdfDocumentPortError extends Error {
  constructor(
    readonly code: PdfDocumentErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PdfDocumentPortError";
  }
}

export interface PdfDocumentPort {
  getPageCount(
    request: PdfDocumentPageCountRequest,
    options?: { signal?: AbortSignal },
  ): Promise<number | undefined>;
  renderPages(
    request: PdfDocumentRenderPagesRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PdfDocumentRenderedPage[]>;
  /**
   * 提取整份 PDF 的逐页文本（specs/pdf-preview-linkage.md）：返回数组的下标 i
   * 对应第 i+1 页，页与页连续且从 1 开始；空页保留为空字符串。
   * pdf_locate 用它做「snippet ↔ 页码」匹配，不渲染图片。
   */
  extractPageTexts(
    request: PdfDocumentPageCountRequest,
    options?: { signal?: AbortSignal },
  ): Promise<string[]>;
}
