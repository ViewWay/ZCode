// pdf_locate 注册门用例（specs/pdf-preview-linkage.md）：
// includePdfLocate 缺省/显式 false → 不注册（TUI/headless/Web/远程形态 fail-closed）；
// 显式 true → 注册。subagent_child 禁用由 runtime-tools 的推导负责
// （includePdfLocate = config.pdfLocateToolEnabled === true && taskType !== "subagent_child"），
// 本用例按 session-chat.test 的同款模式覆盖 registerBuiltInTools 层。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test apps/zcode-cli/packages/core/test/tool/pdf-locate-registration.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import { PDF_LOCATE_TOOL_NAME } from "@zcode/contracts";
import { registerBuiltInTools } from "../../src/tool/handlers/index.js";

function registeredNames(options?: { includePdfLocate?: boolean }): string[] {
  const names: string[] = [];
  registerBuiltInTools(
    { register: (entry) => names.push(entry.metadata.name) },
    options === undefined ? {} : options,
  );
  return names;
}

test("pdf_locate stays unregistered without the desktop gate (fail-closed registration)", () => {
  // 环境缺省（includePdfLocate 未开）：不注册——不存在无桌面形态的降级路径。
  const closedByDefault = registeredNames();
  assert.equal(closedByDefault.includes(PDF_LOCATE_TOOL_NAME), false);
  const closedExplicitly = registeredNames({ includePdfLocate: false });
  assert.equal(closedExplicitly.includes(PDF_LOCATE_TOOL_NAME), false);
});

test("pdf_locate registers with the gate open", () => {
  // Host 桌面形态经 session create/resume 下发 pdfLocateToolEnabled，
  // runtime-tools 推导 includePdfLocate=true：注册。
  const open = registeredNames({ includePdfLocate: true });
  assert.equal(open.includes(PDF_LOCATE_TOOL_NAME), true);
});
