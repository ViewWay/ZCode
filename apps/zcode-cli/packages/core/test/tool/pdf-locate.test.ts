// pdf_locate 工具面单测（specs/pdf-preview-linkage.md）：
// - 端口提取的页文本经匹配器回包 located / page_only / file_opened 三态。
// - 端口缺席：注册门之外走到 handler 属接线故障，抛 ConfigurationError。
// - 非法入参（空 snippet、页码 < 1、多余字段）在入参 parse 即被拒，不触达端口。
// - 端口错误按 read-pdf 同款映射回 ToolHandlerFailure；取消统一转 ToolCancelled。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test apps/zcode-cli/packages/core/test/tool/pdf-locate.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CoreErrorType,
  PdfDocumentPortError,
  ReadErrorCode,
  type CoreError,
  type PdfDocumentPort,
} from "@zcode/contracts";
import { pdfLocateToolEntry } from "../../src/tool/handlers/pdf-locate.js";
import type { ToolExecutionContext } from "../../src/tool/types.js";

function locateContext(port?: PdfDocumentPort): ToolExecutionContext {
  return {
    toolCallId: "test-call",
    traceId: "test-trace" as ToolExecutionContext["traceId"],
    abortSignal: new AbortController().signal,
    workspaceRoot: "/workspaces/demo",
    workingDirectory: "/workspaces/demo",
    sessionId: "sess_self" as ToolExecutionContext["sessionId"],
    ...(port ? { pdfDocumentPort: port } : {}),
  } as ToolExecutionContext;
}

function fakePdfPort(pages: string[]): { port: PdfDocumentPort; extracted: string[] } {
  const extracted: string[] = [];
  const port: PdfDocumentPort = {
    async getPageCount() {
      return pages.length;
    },
    async renderPages() {
      throw new Error("pdf_locate never renders pages");
    },
    async extractPageTexts(request) {
      extracted.push(request.filePath);
      return pages;
    },
  };
  return { port, extracted };
}

function failingPdfPort(code: Parameters<typeof PdfDocumentPortError>[0]): PdfDocumentPort {
  return {
    async getPageCount() {
      return 1;
    },
    async renderPages() {
      throw new Error("unused");
    },
    async extractPageTexts() {
      throw new PdfDocumentPortError(code, `simulated ${code}`);
    },
  };
}

test("pdf_locate returns located when the snippet matches extracted page text", async () => {
  const { port, extracted } = fakePdfPort(["cover", "The quick brown fox jumps."]);
  const output = await pdfLocateToolEntry.handler(
    { file: "/docs/spec.pdf", snippet: "quick brown fox", page: 2 },
    locateContext(port),
  );
  assert.deepEqual(output, { status: "located", page: 2 });
  assert.deepEqual(extracted, ["/docs/spec.pdf"]);
});

test("pdf_locate degrades to page_only when extracted text does not contain the snippet", async () => {
  const { port } = fakePdfPort(["cover", "second page"]);
  const output = await pdfLocateToolEntry.handler(
    { file: "/docs/spec.pdf", snippet: "paraphrased summary", page: 2 },
    locateContext(port),
  );
  assert.deepEqual(output, { status: "page_only", page: 2 });
});

test("pdf_locate degrades to file_opened without a usable page hint", async () => {
  const { port } = fakePdfPort(["cover", "second page"]);
  const output = await pdfLocateToolEntry.handler(
    { file: "/docs/spec.pdf", snippet: "paraphrased summary" },
    locateContext(port),
  );
  assert.deepEqual(output, { status: "file_opened", page: 1 });
});

test("port absence fails fast as a wiring fault", async () => {
  await assert.rejects(
    pdfLocateToolEntry.handler({ file: "/docs/spec.pdf", snippet: "x" }, locateContext(undefined)),
    (error: unknown) => (error as CoreError).type === CoreErrorType.ConfigurationError,
  );
});

test("invalid inputs are rejected before the port is touched", async () => {
  const { port, extracted } = fakePdfPort(["cover"]);
  const context = locateContext(port);
  await assert.rejects(pdfLocateToolEntry.handler({ file: "", snippet: "x" }, context));
  await assert.rejects(pdfLocateToolEntry.handler({ file: "/docs/spec.pdf", snippet: "" }, context));
  await assert.rejects(
    pdfLocateToolEntry.handler({ file: "/docs/spec.pdf", snippet: "x", page: 0 }, context),
  );
  await assert.rejects(
    pdfLocateToolEntry.handler({ file: "/docs/spec.pdf", snippet: "x", extra: 1 }, context),
  );
  assert.deepEqual(extracted, []);
});

test("port password errors map to the read-pdf failure shape", async () => {
  const output = (await pdfLocateToolEntry.handler(
    { file: "/docs/locked.pdf", snippet: "x" },
    locateContext(failingPdfPort("password_protected")),
  )) as { result: false; errorCode: number; message: string };
  assert.equal(output.result, false);
  assert.equal(output.errorCode, ReadErrorCode.PDF_PASSWORD_PROTECTED);
});

test("port cancellation converts to ToolCancelled", async () => {
  await assert.rejects(
    pdfLocateToolEntry.handler(
      { file: "/docs/spec.pdf", snippet: "x" },
      locateContext(failingPdfPort("cancelled")),
    ),
    (error: unknown) => (error as CoreError).type === CoreErrorType.ToolCancelled,
  );
});

test("tool entry declares read-only, no-approval, none-side-effect semantics", () => {
  assert.equal(pdfLocateToolEntry.metadata.readOnly, true);
  assert.equal(pdfLocateToolEntry.metadata.needsApproval, false);
  assert.equal(pdfLocateToolEntry.metadata.sideEffectScope, "none");
  assert.equal(pdfLocateToolEntry.permission.needsApproval, false);
  assert.equal(pdfLocateToolEntry.permission.permission, "pdf.locate");
});
