// PDF 预览联动（specs/pdf-preview-linkage.md）文本层高亮纯逻辑轻测：
// - 空白归一化匹配（PDF 文本层与提取文本的空白形态差异）；
// - 项内命中只包裹局部区间（归一化偏移映射回原文偏移）；
// - 跨文本项：项为命中片段前缀/后缀且达长度门槛 → 整项标记；短项不标；
// - 模型输入的 snippet 含 HTML 时必须转义（不可信文本不进 innerHTML 裸通道）。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test packages/ui/test/pdfLocateTextLayer.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPdfLocateTextRenderer,
  normalizePdfTextForMatch,
  PDF_LOCATE_HIGHLIGHT_CLASS,
  renderPdfTextItemHtml,
} from "../src/pdf/pdfLocateTextLayer.js";

test("normalizePdfTextForMatch collapses whitespace and case", () => {
  assert.equal(normalizePdfTextForMatch("  Foo   Bar\nBaz  "), "foo bar baz");
  assert.equal(normalizePdfTextForMatch("Quoted"), "quoted");
});

test("in-item hit wraps only the matched range (normalized offset mapping)", () => {
  const html = renderPdfTextItemHtml("The quoted passage continues", "quoted  passage");
  assert.equal(
    html,
    `The <mark class="${PDF_LOCATE_HIGHLIGHT_CLASS}">quoted passage</mark> continues`,
  );
});

test("in-item partial range survives multi-space normalization offsets", () => {
  const html = renderPdfTextItemHtml("alpha   beta  gamma", "beta gamma");
  // 原文多空格原样保留在标记外（归一化只用于匹配，不改写原文渲染）。
  assert.equal(html, `alpha   <mark class="${PDF_LOCATE_HIGHLIGHT_CLASS}">beta  gamma</mark>`);
});

test("cross-item head/tail items are marked whole when long enough", () => {
  // 项是命中片段前缀（匹配延续到下一项）→ 整项标记。
  assert.equal(
    renderPdfTextItemHtml("quoted passage", "quoted passage continues here"),
    `<mark class="${PDF_LOCATE_HIGHLIGHT_CLASS}">quoted passage</mark>`,
  );
  // 项是命中片段后缀 → 整项标记。
  assert.equal(
    renderPdfTextItemHtml("continues here", "quoted passage continues here"),
    `<mark class="${PDF_LOCATE_HIGHLIGHT_CLASS}">continues here</mark>`,
  );
});

test("short items never qualify for cross-item whole marking", () => {
  assert.equal(renderPdfTextItemHtml("qu", "quoted passage continues here"), "qu");
});

test("unmatched or snippet-less items render as escaped plain text", () => {
  assert.equal(renderPdfTextItemHtml("Unrelated line", "quoted passage"), "Unrelated line");
  assert.equal(
    renderPdfTextItemHtml("Anything <b>here</b>", ""),
    "Anything &lt;b&gt;here&lt;/b&gt;",
  );
});

test("item text is HTML-escaped inside the highlight mark (snippet is model input)", () => {
  const html = renderPdfTextItemHtml("Risk <script>alert(1)</script>", "risk <script>");
  // 不可信文本不得出现裸 <script>：命中区间以内的内容也必须转义。
  assert.equal(html.includes("<script>alert"), false);
  assert.equal(
    html,
    `<mark class="${PDF_LOCATE_HIGHLIGHT_CLASS}">Risk &lt;script&gt;</mark>alert(1)&lt;/script&gt;`,
  );
});

test("buildPdfLocateTextRenderer disables custom rendering without a snippet", () => {
  assert.equal(buildPdfLocateTextRenderer(undefined), null);
  assert.equal(buildPdfLocateTextRenderer("   "), null);
  const renderer = buildPdfLocateTextRenderer("Quoted");
  assert.equal(typeof renderer, "function");
  assert.equal(
    renderer?.({ str: "the quoted text" }),
    `the <mark class="${PDF_LOCATE_HIGHLIGHT_CLASS}">quoted</mark> text`,
  );
  assert.equal(renderer?.({ str: "other" }), "other");
});
