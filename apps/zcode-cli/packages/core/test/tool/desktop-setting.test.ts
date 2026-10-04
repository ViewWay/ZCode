// agent 可调桌面设置工具面单测（specs/agent-settings.md）：
// - get/set 经内存 DesktopSettingsPort 透传与回包。
// - 白名单外 key / 不合按 key Schema 的 value 在入参 parse 即被拒（可读枚举错误，
//   不触达端口 → 不存在部分写入）。
// - 端口缺席：注册门之外走到 handler 属接线故障，抛 ConfigurationError（照 escalate）。
// - set 回包 key 与请求不一致按接线故障拒绝。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test apps/zcode-cli/packages/core/test/tool/desktop-setting.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import type { DesktopSettingSnapshot, DesktopSettingsPort } from "@zcode/contracts";
import {
  getDesktopSettingToolEntry,
} from "../../src/tool/handlers/get-desktop-setting.js";
import { setDesktopSettingToolEntry } from "../../src/tool/handlers/set-desktop-setting.js";
import type { ToolExecutionContext } from "../../src/tool/types.js";

function settingsContext(port?: DesktopSettingsPort): ToolExecutionContext {
  return {
    toolCallId: "test-call",
    traceId: "test-trace" as ToolExecutionContext["traceId"],
    abortSignal: new AbortController().signal,
    workspaceRoot: "/workspaces/demo",
    workingDirectory: "/workspaces/demo",
    sessionId: "sess_self" as ToolExecutionContext["sessionId"],
    ...(port ? { desktopSettingsPort: port } : {}),
  } as ToolExecutionContext;
}

function inMemoryPort(initial: Partial<Record<string, unknown>>): {
  port: DesktopSettingsPort;
  reads: string[];
  writes: Array<{ key: string; value: unknown }>;
} {
  const state = new Map<string, unknown>(Object.entries(initial));
  const reads: string[] = [];
  const writes: Array<{ key: string; value: unknown }> = [];
  const port: DesktopSettingsPort = {
    async get(key) {
      reads.push(key);
      const snapshot: DesktopSettingSnapshot = {
        key,
        // 测试内存桩直接持有已验证值；未初始化的键给该 key schema 的一个合法占位。
        value: state.get(key) ?? (key === "locale" ? "zh-CN" : key === "theme" ? "system" : false),
        scope: key === "theme" ? "appearance" : "app",
      };
      return snapshot;
    },
    async set(key, value) {
      writes.push({ key, value });
      state.set(key, value);
      return { key, value, scope: key === "theme" ? "appearance" : "app" };
    },
  };
  return { port, reads, writes };
}

test("get_desktop_setting returns the port snapshot as key/value/scope", async () => {
  const { port, reads } = inMemoryPort({ theme: "dark" });
  const output = await getDesktopSettingToolEntry.handler({ key: "theme" }, settingsContext(port));
  assert.deepEqual(reads, ["theme"]);
  assert.deepEqual(output, { key: "theme", value: "dark", scope: "appearance" });
});

test("get_desktop_setting rejects keys outside the whitelist without touching the port", async () => {
  const { port, reads } = inMemoryPort({});
  const context = settingsContext(port);
  await assert.rejects(getDesktopSettingToolEntry.handler({ key: "httpProxy" }, context));
  await assert.rejects(
    getDesktopSettingToolEntry.handler({ key: "shortcutBindings" }, context),
  );
  assert.deepEqual(reads, []);
});

test("set_desktop_setting passes the validated assignment to the port", async () => {
  const { port, writes } = inMemoryPort({});
  const output = await setDesktopSettingToolEntry.handler(
    { key: "notifications.enabled", value: false },
    settingsContext(port),
  );
  assert.deepEqual(writes, [{ key: "notifications.enabled", value: false }]);
  assert.deepEqual(output, {
    key: "notifications.enabled",
    value: false,
    applied: true,
  });
});

test("set_desktop_setting rejects non-whitelisted keys before any write", async () => {
  const { port, writes } = inMemoryPort({});
  const context = settingsContext(port);
  await assert.rejects(setDesktopSettingToolEntry.handler({ key: "httpProxy", value: "http://x" }, context));
  await assert.rejects(
    setDesktopSettingToolEntry.handler(
      { key: "embeddedBrowserAllowInsecureCertificates", value: true },
      context,
    ),
  );
  assert.deepEqual(writes, []);
});

test("set_desktop_setting rejects values not matching the per-key schema", async () => {
  const { port, writes } = inMemoryPort({});
  const context = settingsContext(port);
  await assert.rejects(setDesktopSettingToolEntry.handler({ key: "locale", value: "fr-FR" }, context));
  await assert.rejects(setDesktopSettingToolEntry.handler({ key: "theme", value: "blue" }, context));
  await assert.rejects(
    setDesktopSettingToolEntry.handler({ key: "notifications.enabled", value: "yes" }, context),
  );
  assert.deepEqual(writes, []);
});

test("port absence fails fast as a wiring fault for both tools", async () => {
  const context = settingsContext(undefined);
  await assert.rejects(getDesktopSettingToolEntry.handler({ key: "locale" }, context));
  await assert.rejects(
    setDesktopSettingToolEntry.handler({ key: "locale", value: "en-US" }, context),
  );
});

test("set refuses a port snapshot written to a different key", async () => {
  const port: DesktopSettingsPort = {
    async get() {
      throw new Error("unused");
    },
    async set() {
      // 接线故障模拟：请求改 locale，端口却回写 theme。
      return { key: "theme", value: "dark", scope: "appearance" };
    },
  };
  await assert.rejects(
    setDesktopSettingToolEntry.handler({ key: "locale", value: "en-US" }, settingsContext(port)),
  );
});

test("tool entries declare read-only vs ask permission semantics", () => {
  assert.equal(getDesktopSettingToolEntry.metadata.readOnly, true);
  assert.equal(getDesktopSettingToolEntry.metadata.needsApproval, false);
  assert.equal(getDesktopSettingToolEntry.permission.needsApproval, false);
  assert.equal(setDesktopSettingToolEntry.metadata.readOnly, false);
  assert.equal(setDesktopSettingToolEntry.metadata.needsApproval, true);
  assert.equal(setDesktopSettingToolEntry.permission.needsApproval, true);
  assert.equal(setDesktopSettingToolEntry.permission.permission, "desktop.settings.write");
  assert.equal(setDesktopSettingToolEntry.metadata.sideEffectScope, "system");
});
