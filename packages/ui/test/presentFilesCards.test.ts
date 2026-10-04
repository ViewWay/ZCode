// 交付物卡片（present_files）纯逻辑轻测（specs/deliverable-cards.md）：
// - 声明读取：流式取 input.files、完成态取 output.accepted；非 present_files 名字不认领。
// - 卡片派生：去重保序、文件名取路径叶子（含 Windows 分隔符）。
// - 预览源：卡片点击走 media-preview 打开路径（CodeViewerSource file 投影）。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test packages/ui/test/presentFilesCards.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPresentFilesCardPreviewSource,
  buildPresentFilesCards,
  isPresentFilesToolName,
  readPresentFilesDeclaration,
} from "../src/lib/presentFilesCards.js";

test("isPresentFilesToolName matches the fixed tool name case-insensitively", () => {
  assert.equal(isPresentFilesToolName("present_files"), true);
  assert.equal(isPresentFilesToolName(" Present_Files "), true);
  assert.equal(isPresentFilesToolName("write"), false);
  assert.equal(isPresentFilesToolName(null), false);
});

test("declaration reads input.files while the tool call is streaming", () => {
  const declaration = readPresentFilesDeclaration({
    toolName: "present_files",
    input: { files: ["/workspaces/demo/report.html"], note: "Final report" },
    output: undefined,
  });
  assert.deepEqual(declaration, {
    files: ["/workspaces/demo/report.html"],
    note: "Final report",
    completed: false,
  });
});

test("declaration prefers output.accepted once the tool call completed", () => {
  const declaration = readPresentFilesDeclaration({
    toolName: "present_files",
    input: { files: ["/a.html", "/b.html"] },
    output: { accepted: ["/b.html"] },
  });
  assert.deepEqual(declaration, { files: ["/b.html"], note: undefined, completed: true });
});

test("declaration ignores other tools and garbage inputs", () => {
  assert.equal(readPresentFilesDeclaration({ toolName: "write", input: { files: ["/a"] } }), null);
  assert.equal(readPresentFilesDeclaration({ toolName: "present_files", input: {} }), null);
  assert.equal(
    readPresentFilesDeclaration({ toolName: "present_files", input: { files: "nope" } }),
    null,
  );
  assert.equal(readPresentFilesDeclaration({ toolName: "present_files" }), null);
});

test("cards deduplicate paths and keep declaration order", () => {
  const declaration = readPresentFilesDeclaration({
    toolName: "present_files",
    input: { files: ["/a.html", "/b.html", "/a.html"] },
  });
  const cards = buildPresentFilesCards(declaration!);
  assert.deepEqual(
    cards.map((card) => card.path),
    ["/a.html", "/b.html"],
  );
});

test("card file names use the path leaf, including windows separators", () => {
  const declaration = readPresentFilesDeclaration({
    toolName: "present_files",
    input: { files: ["C:\\Users\\demo\\report.html"] },
  });
  const cards = buildPresentFilesCards(declaration!);
  assert.equal(cards[0]?.fileName, "report.html");
});

test("card preview source projects a media-preview file open request", () => {
  const declaration = readPresentFilesDeclaration({
    toolName: "present_files",
    input: { files: ["/workspaces/demo/report.html"] },
  });
  const card = buildPresentFilesCards(declaration!)[0]!;
  assert.deepEqual(buildPresentFilesCardPreviewSource(card, "/workspaces/demo"), {
    type: "file",
    title: "report.html",
    path: "/workspaces/demo/report.html",
    workspacePath: "/workspaces/demo",
  });
  // 无 workspace scope（只读时间线等）也能打开，只是不带工作区归一。
  assert.deepEqual(buildPresentFilesCardPreviewSource(card), {
    type: "file",
    title: "report.html",
    path: "/workspaces/demo/report.html",
  });
});
