// ============================================================
// PDF 片段匹配器 - pdf_locate 的纯函数核心（specs/pdf-preview-linkage.md）
// ============================================================
// 输入是「页文本数组」（下标 i 对应第 i+1 页，来自 PdfDocumentPort.extractPageTexts）
// 加模型提供的 snippet 与可选页码，输出 status + page。匹配顺序：
// 精确匹配 → 归一化空白匹配 → 降级（仅页码 / 仅打开文件）。
// 纯函数、无 IO；core handler 与单测共用同一套判定。

import type { PdfLocateStatus } from "@zcode/contracts";

export interface PdfLocateMatchOutcome {
  status: PdfLocateStatus;
  page: number;
}

/** 把任意空白串折叠成单个空格并去首尾空白；\s 覆盖全角空格与 NBSP，不折叠大小写（snippet 要求逐字）。 */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** 页码是否落在文档页数内；越界的提示页按缺失处理，不让它污染翻页降级。 */
function isUsableHintedPage(page: number | undefined, pageCount: number): page is number {
  return page !== undefined && Number.isSafeInteger(page) && page >= 1 && page <= pageCount;
}

/** 先看提示页（模型刚读过、最可能命中），再按页序扫全文档。 */
function pageScanOrder(pageCount: number, hintedPage: number | undefined): number[] {
  const order: number[] = [];
  if (isUsableHintedPage(hintedPage, pageCount)) {
    order.push(hintedPage);
  }
  for (let page = 1; page <= pageCount; page += 1) {
    if (page !== hintedPage) {
      order.push(page);
    }
  }
  return order;
}

/**
 * 在页文本数组中定位 snippet。
 * - 精确匹配：snippet 逐字出现在某页文本中 → located；
 * - 归一化空白匹配：提取文本的换行/多余空格不影响判定 → located；
 * - 降级：无任何匹配时有合法提示页码 → page_only；否则 → file_opened（首页）。
 */
export function matchPdfSnippet(
  pageTexts: readonly string[],
  snippet: string,
  hintedPage?: number,
): PdfLocateMatchOutcome {
  // 空页数组无法构成「第 1 页」的前提，按单页空文本处理，保证输出页码始终 ≥1。
  const pages = pageTexts.length > 0 ? pageTexts : [""];
  const pageCount = pages.length;
  const scanOrder = pageScanOrder(pageCount, hintedPage);

  // 空字符串会命中 includes("") 的第一页，先短路成降级路径。
  if (snippet.length > 0) {
    for (const page of scanOrder) {
      if (pages[page - 1].includes(snippet)) {
        return { status: "located", page };
      }
    }

    const normalizedSnippet = normalizeWhitespace(snippet);
    if (normalizedSnippet.length > 0) {
      const normalizedPages = pages.map(normalizeWhitespace);
      for (const page of scanOrder) {
        if (normalizedPages[page - 1].includes(normalizedSnippet)) {
          return { status: "located", page };
        }
      }
    }
  }

  if (isUsableHintedPage(hintedPage, pageCount)) {
    return { status: "page_only", page: hintedPage };
  }
  return { status: "file_opened", page: 1 };
}
