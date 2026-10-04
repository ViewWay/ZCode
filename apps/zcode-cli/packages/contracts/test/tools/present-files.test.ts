// present_files 工具契约单测（specs/deliverable-cards.md）：
// - 合法/非法入参（空数组、超量、非字符串、多余字段、note 超长）。
// - 输出 schema 只接受 accepted 数组（拒绝多余字段）。
// - 工具名与 @zcode/shared 的单一事实源一致（UI 卡片按它认领）。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test apps/zcode-cli/packages/contracts/test/tools/present-files.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import { PRESENT_FILES_TOOL_NAME as SHARED_TOOL_NAME } from "@zcode/shared";
import {
  PRESENT_FILES_MAX_FILES,
  PRESENT_FILES_NOTE_MAX_CHARS,
  PRESENT_FILES_TOOL_NAME,
  PresentFilesInputJsonSchema,
  PresentFilesInputSchema,
  PresentFilesOutputJsonSchema,
  PresentFilesOutputSchema,
} from "../../src/tools/present-files.js";

test("tool name stays in sync with the @zcode/shared single source", () => {
  assert.equal(PRESENT_FILES_TOOL_NAME, "present_files");
  assert.equal(PRESENT_FILES_TOOL_NAME, SHARED_TOOL_NAME);
});

test("present_files input accepts absolute file paths with optional note", () => {
  const parsed = PresentFilesInputSchema.parse({
    files: ["/workspaces/demo/report.html", "/workspaces/demo/data.csv"],
    note: "Final report and dataset",
  });
  assert.deepEqual(parsed.files, ["/workspaces/demo/report.html", "/workspaces/demo/data.csv"]);
  assert.equal(parsed.note, "Final report and dataset");
});

test("present_files input rejects empty, oversized or non-string file lists", () => {
  assert.equal(PresentFilesInputSchema.safeParse({ files: [] }).success, false);
  assert.equal(
    PresentFilesInputSchema.safeParse({ files: ["", "/ok.txt"] }).success,
    false,
  );
  assert.equal(PresentFilesInputSchema.safeParse({ files: "report.html" }).success, false);
  assert.equal(
    PresentFilesInputSchema.safeParse({ files: Array(PRESENT_FILES_MAX_FILES + 1).fill("/f.txt") })
      .success,
    false,
  );
});

test("present_files input rejects unknown fields and overlong notes", () => {
  assert.equal(PresentFilesInputSchema.safeParse({ files: ["/a"], extra: 1 }).success, false);
  assert.equal(
    PresentFilesInputSchema.safeParse({ files: ["/a"], note: "x".repeat(PRESENT_FILES_NOTE_MAX_CHARS + 1) })
      .success,
    false,
  );
});

test("present_files output accepts accepted array and rejects anything else", () => {
  assert.deepEqual(PresentFilesOutputSchema.parse({ accepted: ["/a", "/b"] }), {
    accepted: ["/a", "/b"],
  });
  assert.equal(PresentFilesOutputSchema.safeParse({ accepted: ["/a"], ok: true }).success, false);
  assert.equal(PresentFilesOutputSchema.safeParse({}).success, false);
});

test("json schemas project valid tool schema shapes", () => {
  assert.equal(PresentFilesInputJsonSchema.type, "object");
  assert.equal(PresentFilesOutputJsonSchema.type, "object");
  assert.ok(PresentFilesInputJsonSchema.properties?.files);
  assert.ok(PresentFilesOutputJsonSchema.properties?.accepted);
});
