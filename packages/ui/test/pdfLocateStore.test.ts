// PDF 预览联动（specs/pdf-preview-linkage.md）pending 定位 store 轻测：
// publish 覆盖先到、consume 只消费路径匹配的请求、不匹配保留等待预览切换。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test packages/ui/test/pdfLocateStore.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import { isSamePdfPath, usePdfLocateStore } from "../src/store/pdfLocateStore.js";

const REQUEST = {
  filePath: "/workspaces/demo/report.pdf",
  fileName: "report.pdf",
  snippet: "quoted passage",
  page: 3,
  status: "located" as const,
};

function resetStore() {
  usePdfLocateStore.getState().clear();
}

test("publish then consume returns the request once and clears pending", () => {
  resetStore();
  usePdfLocateStore.getState().publish(REQUEST);
  const consumed = usePdfLocateStore.getState().consume("/workspaces/demo/report.pdf");
  assert.equal(consumed?.page, REQUEST.page);
  assert.equal(consumed?.snippet, REQUEST.snippet);
  assert.ok(consumed?.requestId);
  assert.equal(usePdfLocateStore.getState().pending, null);
  assert.equal(usePdfLocateStore.getState().consume("/workspaces/demo/report.pdf"), null);
});

test("consume keeps pending when the preview shows a different file", () => {
  resetStore();
  usePdfLocateStore.getState().publish(REQUEST);
  assert.equal(usePdfLocateStore.getState().consume("/workspaces/demo/other.pdf"), null);
  assert.equal(usePdfLocateStore.getState().pending?.filePath, REQUEST.filePath);
  // 预览切换到目标文件后消费成功。
  assert.equal(usePdfLocateStore.getState().consume("/workspaces/demo/report.pdf")?.page, 3);
});

test("later publish overwrites the earlier pending request", () => {
  resetStore();
  usePdfLocateStore.getState().publish(REQUEST);
  const secondRequestId = usePdfLocateStore.getState().pending?.requestId;
  usePdfLocateStore.getState().publish({ ...REQUEST, page: 9, status: "page_only" });
  const consumed = usePdfLocateStore.getState().consume(REQUEST.filePath);
  assert.equal(consumed?.page, 9);
  assert.ok(consumed && consumed.requestId > (secondRequestId ?? 0));
});

test("isSamePdfPath tolerates trailing separators and case, not different files", () => {
  assert.equal(isSamePdfPath("/a/b/report.pdf", "/a/b/report.pdf/"), true);
  assert.equal(isSamePdfPath("/A/B/Report.PDF", "/a/b/report.pdf"), true);
  assert.equal(isSamePdfPath("/a/b/report.pdf", "/a/b/other.pdf"), false);
});
