// pdf_locate 匹配器单测（specs/pdf-preview-linkage.md）——三类用例：
// - 精确匹配：snippet 逐字出现在某页文本中；
// - 归一化空白匹配：提取文本的换行/多余空格/全角空格不影响判定；
// - 降级：无匹配时按合法提示页码翻页（page_only），无页码仅打开文件（file_opened）。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test apps/zcode-cli/packages/core/test/tool/pdf-locate-matcher.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import { matchPdfSnippet } from "../../src/pdf-locate/matcher.js";

const PAGES = [
  "Introduction\n\nThis document describes the ZCode protocol.",
  "Second page\n\nThe quick brown fox jumps over the lazy dog.",
  "Third page\n\nConclusion and future work.",
];

test("exact match: verbatim snippet located on its page", () => {
  assert.deepEqual(matchPdfSnippet(PAGES, "quick brown fox"), { status: "located", page: 2 });
  assert.deepEqual(matchPdfSnippet(PAGES, "Conclusion and future work."), { status: "located", page: 3 });
});

test("exact match trusts the text over the hinted page", () => {
  // snippet 实际在第 1 页、模型却提示第 3 页时，按文本事实返回第 1 页。
  assert.deepEqual(matchPdfSnippet(PAGES, "Introduction", 3), { status: "located", page: 1 });
});

test("exact match scans the hinted page first when several pages contain the snippet", () => {
  const pages = ["shared text", "shared text"];
  assert.deepEqual(matchPdfSnippet(pages, "shared text", 2), { status: "located", page: 2 });
});

test("normalized whitespace match: line breaks and repeated spaces do not break matching", () => {
  // PDF 文本提取常把一句引文拆成多行并夹入多余空格。
  const pages = ["first page", "The quick   brown\nfox\njumps over the lazy dog.", "third"];
  assert.deepEqual(matchPdfSnippet(pages, "The quick brown fox jumps over the lazy dog."), {
    status: "located",
    page: 2,
  });
});

test("normalized whitespace match: ideographic space and NBSP are folded like plain spaces", () => {
  assert.deepEqual(matchPdfSnippet(["全角　空格 与 NBSP 文本"], "全角 空格 与 NBSP 文本"), {
    status: "located",
    page: 1,
  });
});

test("degraded: page_only uses the valid hinted page when nothing matches", () => {
  assert.deepEqual(matchPdfSnippet(PAGES, "paraphrased summary", 3), { status: "page_only", page: 3 });
});

test("degraded: file_opened when nothing matches and no usable page hint", () => {
  assert.deepEqual(matchPdfSnippet(PAGES, "paraphrased summary"), { status: "file_opened", page: 1 });
  // 越界提示页按缺失处理，不让它污染翻页降级。
  assert.deepEqual(matchPdfSnippet(PAGES, "paraphrased summary", 99), { status: "file_opened", page: 1 });
});

test("matcher stays total on edge inputs", () => {
  // 空页数组按单页空文本处理，输出页码始终 >= 1。
  assert.deepEqual(matchPdfSnippet([], "anything"), { status: "file_opened", page: 1 });
  // 空白 snippet 不允许命中（schema 层已拦 min(1)，这里验证短路到降级）。
  assert.deepEqual(matchPdfSnippet(PAGES, "", 2), { status: "page_only", page: 2 });
  // 空白页保留页位：第 2 页空白不影响第 3 页命中。
  assert.deepEqual(matchPdfSnippet(["cover", "", "hidden treasure"], "hidden treasure"), {
    status: "located",
    page: 3,
  });
});
