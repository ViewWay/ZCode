// PDF 预览联动（specs/pdf-preview-linkage.md）文本层高亮纯逻辑轻测：
// - 空白归一化匹配（PDF 文本层与提取文本的空白形态差异）；
// - 匹配项整段 <mark> 包裹、非匹配项原样输出、无 snippet 时关闭自定义渲染；
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

test("matched text item is wrapped in a highlight mark", () => {
  const html = renderPdfTextItemHtml("The quoted passage continues", "quoted  passage");
  assert.equal(
    html,
    `<mark class="${PDF_LOCATE_HIGHLIGHT_CLASS}">The quoted passage continues</mark>`,
  );
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
  assert.equal(html.includes("<script>alert"), false);
  assert.equal(
    html,
    `<mark class="${PDF_LOCATE_HIGHLIGHT_CLASS}">Risk &lt;script&gt;alert(1)&lt;/script&gt;</mark>`,
  );
});

test("buildPdfLocateTextRenderer disables custom rendering without a snippet", () => {
  assert.equal(buildPdfLocateTextRenderer(undefined), null);
  assert.equal(buildPdfLocateTextRenderer("   "), null);
  const renderer = buildPdfLocateTextRenderer("Quoted");
  assert.equal(typeof renderer, "function");
  assert.equal(
    renderer?.({ str: "the quoted text" }),
    `<mark class="${PDF_LOCATE_HIGHLIGHT_CLASS}">the quoted text</mark>`,
  );
  assert.equal(renderer?.({ str: "other" }), "other");
});
