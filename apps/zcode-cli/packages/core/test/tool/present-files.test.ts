// present_files 工具 handler 单测（specs/deliverable-cards.md）：
// - 路径透传：accepted 与输入一致（去重保序）。
// - 纯声明：handler 全程不触碰文件系统（非法入参在 parse 即被拒，不产生部分输出）。
// - ToolEntry 元数据：readOnly / sideEffectScope "none" / needsApproval false。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test apps/zcode-cli/packages/core/test/tool/present-files.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import { presentFilesToolEntry } from "../../src/tool/handlers/present-files.js";
import type { ToolExecutionContext } from "../../src/tool/types.js";

function presentFilesContext(): ToolExecutionContext {
  return {
    toolCallId: "test-present-files",
    traceId: "test-trace" as ToolExecutionContext["traceId"],
    abortSignal: new AbortController().signal,
    workspaceRoot: "/workspaces/demo",
    workingDirectory: "/workspaces/demo",
    sessionId: "sess_self" as ToolExecutionContext["sessionId"],
  } as ToolExecutionContext;
}

test("present_files passes declared paths through unchanged", async () => {
  const output = await presentFilesToolEntry.handler(
    { files: ["/workspaces/demo/report.html", "/workspaces/demo/data.csv"] },
    presentFilesContext(),
  );
  assert.deepEqual(output, {
    accepted: ["/workspaces/demo/report.html", "/workspaces/demo/data.csv"],
  });
});

test("present_files deduplicates repeated paths while keeping declaration order", async () => {
  const output = await presentFilesToolEntry.handler(
    { files: ["/a.html", "/b.html", "/a.html"] },
    presentFilesContext(),
  );
  assert.deepEqual(output, { accepted: ["/a.html", "/b.html"] });
});

test("present_files carries the note through the context without side effects", async () => {
  // note 只进模型面文案，不进输出；这里主要确认带 note 的入参不炸。
  const output = await presentFilesToolEntry.handler(
    { files: ["/a.html"], note: "Final deliverable" },
    presentFilesContext(),
  );
  assert.deepEqual(output, { accepted: ["/a.html"] });
});

test("present_files rejects invalid input at parse time", async () => {
  const context = presentFilesContext();
  await assert.rejects(presentFilesToolEntry.handler({ files: [] }, context));
  await assert.rejects(presentFilesToolEntry.handler({ files: [123] }, context));
  await assert.rejects(presentFilesToolEntry.handler({ paths: ["/a"] }, context));
});

test("present_files metadata declares a read-only, side-effect-free tool", () => {
  const { metadata, permission } = presentFilesToolEntry;
  assert.equal(metadata.name, "present_files");
  assert.equal(metadata.readOnly, true);
  assert.equal(metadata.destructive, false);
  assert.equal(metadata.sideEffectScope, "none");
  assert.equal(metadata.needsApproval, false);
  assert.equal(permission.needsApproval, false);
  assert.equal(permission.sideEffectScope, "none");
});

test("present_files model content lists the accepted deliverables", () => {
  const text = presentFilesToolEntry.formatModelContent?.({ accepted: ["/a.html", "/b.html"] });
  assert.match(text ?? "", /\/a\.html/);
  assert.match(text ?? "", /\/b\.html/);
  // 非法输出不静默成功，而是给出可读错误行。
  assert.match(presentFilesToolEntry.formatModelContent?.({}) ?? "", /invalid result/);
});
