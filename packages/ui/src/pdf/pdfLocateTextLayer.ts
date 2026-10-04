/**
 * PDF 预览联动（specs/pdf-preview-linkage.md）的文本层高亮纯逻辑。
 *
 * react-pdf 的 customTextRenderer 回调按文本项回调并要求返回 HTML 字符串。本模块把
 * snippet 匹配与 HTML 拼装拆成纯函数：
 * - 匹配一律基于空白归一化（PDF 文本层与 pdftotext 的空白形态经常不同）；
 * - 项内命中 → 只包裹命中的局部区间（归一化偏移映射回原文字符偏移）；
 * - 项是命中片段的前缀/后缀（跨文本项场景）→ 整项标记；其余原样转义返回；
 * - 全部输出经 HTML 转义，snippet 来自模型输入，必须当不可信文本处理。
 */

/** 高亮 <mark> 的样式类；样式定义在 styles.css（双主题变量）。 */
export const PDF_LOCATE_HIGHLIGHT_CLASS = "pdf-locate-highlight";

/** 跨项前缀/后缀整项标记的最短项长度门槛：低于该长度的项不做跨项判定（防误标）。 */
export const PDF_LOCATE_CROSS_ITEM_MIN_CHARS = 4;

/** 匹配用归一化：所有空白折叠为单个空格 + 小写。 */
export function normalizePdfTextForMatch(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * 把归一化文本中的字符下标映射回原文字符下标。
 * 返回数组长度 = 归一化后长度；每个元素是该归一化字符在原文中的起始下标。
 */
export function buildNormalizedOffsetMap(text: string): number[] {
  const map: number[] = [];
  let normalizedIndex = 0;
  let firstWhitespaceIndex = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      // 记录空白串首字符：折叠出的归一化空格映射到它（保持标记区间不吞词后空格）。
      if (firstWhitespaceIndex < 0) {
        firstWhitespaceIndex = i;
      }
      continue;
    }
    if (firstWhitespaceIndex >= 0 && normalizedIndex > 0) {
      map.push(firstWhitespaceIndex);
      normalizedIndex += 1;
    }
    firstWhitespaceIndex = -1;
    map.push(i);
    normalizedIndex += 1;
  }
  return map;
}

/**
 * 项内局部区间：在原文 text 中找 normalizedSnippet 的首处归一化命中，
 * 返回原文字符区间 [start, end)（end 不含）；未命中返回 null。
 */
export function mapNormalizedMatchRange(
  text: string,
  normalizedSnippet: string,
): { start: number; end: number } | null {
  if (!normalizedSnippet) return null;
  const normalizedText = normalizePdfTextForMatch(text);
  const hit = normalizedText.indexOf(normalizedSnippet);
  if (hit < 0) return null;
  const map = buildNormalizedOffsetMap(text);
  const start = map[hit]!;
  const lastNormalized = hit + normalizedSnippet.length - 1;
  const end = lastNormalized + 1 < map.length ? map[lastNormalized + 1]! : text.length;
  return { start, end };
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
 * 渲染单个文本项的文本层 HTML：项内命中包裹局部区间；项是命中片段的前缀/后缀
 * （跨文本项场景，整项长度达到门槛）→ 整项标记；否则原样转义返回。
 */
export function renderPdfTextItemHtml(str: string, snippet: string): string {
  const normalizedSnippet = snippet ? normalizePdfTextForMatch(snippet) : "";
  if (!normalizedSnippet) {
    return escapeHtml(str);
  }
  const itemNormalized = normalizePdfTextForMatch(str);
  if (itemNormalized.includes(normalizedSnippet)) {
    const range = mapNormalizedMatchRange(str, normalizedSnippet);
    if (range) {
      return `${escapeHtml(str.slice(0, range.start))}<mark class="${PDF_LOCATE_HIGHLIGHT_CLASS}">${escapeHtml(str.slice(range.start, range.end))}</mark>${escapeHtml(str.slice(range.end))}`;
    }
  }
  // 跨文本项：本项是命中片段的前缀（匹配延续到下一项）或后缀（延续自上一项）→
  // 整项标记。门槛防短项误标（单字符项几乎必然是某片段的前缀）。
  if (
    itemNormalized.length >= PDF_LOCATE_CROSS_ITEM_MIN_CHARS &&
    (normalizedSnippet.startsWith(itemNormalized) || normalizedSnippet.endsWith(itemNormalized))
  ) {
    return `<mark class="${PDF_LOCATE_HIGHLIGHT_CLASS}">${escapeHtml(str)}</mark>`;
  }
  return escapeHtml(str);
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
