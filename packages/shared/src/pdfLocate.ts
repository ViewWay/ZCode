// ============================================================
// PDF Locate - renderer 侧共享事实（specs/pdf-preview-linkage.md）
// ============================================================
// pdf_locate 不新增协议事件：工具调用记录（入参 + 模型回显文本）就是定位指令的
// 载体，已随既有 session 事件流下发。本模块给 renderer 提供 UI 侧需要的单一事实：
// 工具名常量 + 模型回显文本的宽容解析（core 侧 formatPdfLocateModelContent 的
// 三种稳定句式，见 apps/zcode-cli/packages/core/src/tool/handlers/pdf-locate.ts；
// 两端以本文件的单测锚定同一组句子，改句式必须两侧同步）。

/** 与 contracts 的 PDF_LOCATE_TOOL_NAME 同名同值；UI 包不能依赖 CLI contracts。 */
export const PDF_LOCATE_TOOL_NAME = "pdf_locate";

/** core handler 的 status 三态（renderer 只消费，不复算）。 */
export type PdfLocateStatus = "located" | "page_only" | "file_opened";

export interface PdfLocateModelText {
  status: PdfLocateStatus;
  /** 权威页码（1-indexed）：匹配页可能与模型自报 page 不同，以回显为准。 */
  page: number;
}

/** 三种稳定句式的状态锚点；正则按锚点 + 末尾 "page N" 宽容提取。 */
const PDF_LOCATE_STATUS_ANCHORS: ReadonlyArray<[PdfLocateStatus, string]> = [
  ["located", "highlighted on page"],
  ["page_only", "preview moved to page"],
  ["file_opened", "opened the file at page"],
];

/**
 * 解析 pdf_locate 的模型回显文本；非本工具或页码缺失返回 null。
 * 宽容策略：只要求包含 "pdf_locate:" 前缀语义（状态锚点本身含 "page"），
 * 不整句全等——句尾句点、i18n 变化都不应破坏解析。
 */
export function parsePdfLocateModelText(text: string): PdfLocateModelText | null {
  const value = text.trim();
  if (!value.toLowerCase().startsWith(`${PDF_LOCATE_TOOL_NAME}:`)) {
    return null;
  }
  for (const [status, anchor] of PDF_LOCATE_STATUS_ANCHORS) {
    const anchorIndex = value.toLowerCase().indexOf(anchor);
    if (anchorIndex === -1) {
      continue;
    }
    const pageMatch = /\bpage\s+(\d+)\b/i.exec(value.slice(anchorIndex));
    if (pageMatch) {
      const page = Number.parseInt(pageMatch[1] ?? "", 10);
      if (Number.isInteger(page) && page >= 1) {
        return { status, page };
      }
    }
  }
  return null;
}
