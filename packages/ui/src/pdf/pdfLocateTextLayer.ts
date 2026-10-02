/**
 * PDF 预览联动（specs/pdf-preview-linkage.md）的文本层高亮纯逻辑。
 *
 * react-pdf 的 customTextRenderer 按文本项（text item，通常是一行/一个短语）回调并
 * 要求返回 HTML 字符串。本模块把 snippet 匹配与 HTML 拼装拆成纯函数：
 * - 空白归一化匹配（PDF 文本层与 pdftotext 提取的空白形态经常不同）；
 * - 匹配到 → 整项包裹 <mark>（v1 不做项内局部区间：归一化改变了字符偏移，
 *   跨文本项的片段区间归 v2；匹配不到 → 原样返回，预览保持仅翻页）；
 * - 全部输出经 HTML 转义，snippet 来自模型输入，必须当不可信文本处理。
 */

/** 高亮 <mark> 的样式类；样式定义在 styles.css（light/dark 双主题变量）。 */
export const PDF_LOCATE_HIGHLIGHT_CLASS = "pdf-locate-highlight";

/** 匹配用归一化：所有空白折叠为单个空格 + 小写（路径/文本层大小写不稳定）。 */
export function normalizePdfTextForMatch(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * 渲染单个文本项的文本层 HTML。snippet 入参为原始片段（内部归一化，传入已归一化
 * 值亦幂等）；为空（无 snippet / 已匹配失败）时原样转义返回。
 */
export function renderPdfTextItemHtml(str: string, snippet: string): string {
  const escaped = escapeHtml(str);
  const normalizedSnippet = snippet ? normalizePdfTextForMatch(snippet) : "";
  if (!normalizedSnippet) {
    return escaped;
  }
  return normalizePdfTextForMatch(str).includes(normalizedSnippet)
    ? `<mark class="${PDF_LOCATE_HIGHLIGHT_CLASS}">${escaped}</mark>`
    : escaped;
}

/**
 * 生成 react-pdf <Page customTextRenderer>。
 * snippet 归一化一次；返回 null 表示本轮不需要文本层自定义渲染。
 */
export function buildPdfLocateTextRenderer(
  snippet: string | undefined,
): null | ((item: { str: string }) => string) {
  const normalizedSnippet = snippet ? normalizePdfTextForMatch(snippet) : "";
  if (!normalizedSnippet) {
    return null;
  }
  return (item) => renderPdfTextItemHtml(item.str, normalizedSnippet);
}
