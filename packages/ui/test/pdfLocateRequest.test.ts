// PDF 预览联动（specs/pdf-preview-linkage.md）定位事件链纯逻辑轻测：
// - 回显文本解析（parsePdfLocateModelText）：锚定 core formatPdfLocateModelContent 的
//   三种稳定句式——core 侧改句式必须同步 shared/src/pdfLocate.ts 与本用例；
// - 工具调用读取（readPdfLocateRequest）：流式挂起、完成态权威页/降级页、名字认领。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test packages/ui/test/pdfLocateRequest.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePdfLocateModelText, PDF_LOCATE_TOOL_NAME } from "@zcode/shared";
import { isPdfLocateToolName, readPdfLocateRequest } from "../src/lib/pdfLocateRequest.js";

// ── 回显文本解析（与 core handler 的 formatPdfLocateModelContent 句式锚定） ──

test("parsePdfLocateModelText reads the three core formatter sentences", () => {
  assert.deepEqual(parsePdfLocateModelText("pdf_locate: snippet highlighted on page 3."), {
    status: "located",
    page: 3,
  });
  assert.deepEqual(
    parsePdfLocateModelText("pdf_locate: snippet not matched; preview moved to page 12."),
    { status: "page_only", page: 12 },
  );
  assert.deepEqual(
    parsePdfLocateModelText(
      "pdf_locate: snippet not matched and no page given; preview opened the file at page 1.",
    ),
    { status: "file_opened", page: 1 },
  );
});

test("parsePdfLocateModelText rejects other tools and pageless text", () => {
  assert.equal(parsePdfLocateModelText("write: done"), null);
  assert.equal(parsePdfLocateModelText("pdf_locate: something else"), null);
  assert.equal(parsePdfLocateModelText(""), null);
});

test("isPdfLocateToolName matches the fixed tool name case-insensitively", () => {
  assert.equal(isPdfLocateToolName(PDF_LOCATE_TOOL_NAME), true);
  assert.equal(isPdfLocateToolName(" PDF_Locate "), true);
  assert.equal(isPdfLocateToolName("write"), false);
  assert.equal(isPdfLocateToolName(null), false);
});

// ── 工具调用 → 定位请求 ──

const BASE_CALL = {
  toolName: PDF_LOCATE_TOOL_NAME,
  toolId: "call_1",
  status: "completed",
  input: { file: "/workspaces/demo/report.pdf", snippet: "quoted passage", page: 7 },
};

test("readPdfLocateRequest prefers the authoritative page from the output text", () => {
  const request = readPdfLocateRequest({
    ...BASE_CALL,
    output: "pdf_locate: snippet highlighted on page 9.",
  });
  assert.deepEqual(request, {
    filePath: "/workspaces/demo/report.pdf",
    fileName: "report.pdf",
    snippet: "quoted passage",
    page: 9,
    status: "located",
  });
});

test("readPdfLocateRequest returns null while output has not arrived (pending card)", () => {
  assert.equal(
    readPdfLocateRequest({ ...BASE_CALL, status: "in_progress", output: undefined }),
    null,
  );
  assert.equal(readPdfLocateRequest({ ...BASE_CALL, output: undefined }), null);
});

test("readPdfLocateRequest falls back to input page when output text is unparseable", () => {
  const request = readPdfLocateRequest({
    ...BASE_CALL,
    output: "pdf_locate returned an invalid result.",
  });
  assert.deepEqual(request, {
    filePath: "/workspaces/demo/report.pdf",
    fileName: "report.pdf",
    snippet: "quoted passage",
    page: 7,
    status: null,
  });
  // 无入参页码：与 core 的 file_opened 语义对齐，落到第 1 页。
  const noPage = readPdfLocateRequest({
    ...BASE_CALL,
    input: { file: "/workspaces/demo/report.pdf", snippet: "quoted passage" },
    output: "unparseable",
  });
  assert.equal(noPage?.page, 1);
});

test("readPdfLocateRequest does not claim other tools or calls without a file", () => {
  assert.equal(readPdfLocateRequest({ ...BASE_CALL, toolName: "write", output: "ok" }), null);
  assert.equal(
    readPdfLocateRequest({
      ...BASE_CALL,
      input: { snippet: "quoted passage" },
      output: "pdf_locate: snippet highlighted on page 2.",
    }),
    null,
  );
});
