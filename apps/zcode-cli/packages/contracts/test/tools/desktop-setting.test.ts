// agent 可调桌面设置契约单测（specs/agent-settings.md）：白名单三类用例
// （合法 key / 非法 key / 非法 value）+ scope 映射 + 与 @zcode/shared 协议白名单的
// 键集同步（两把尺各自独立定义，漂移必须在这里炸出来）。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test apps/zcode-cli/packages/contracts/test/tools/desktop-setting.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import { appSettingsPatchSchema, zcodeDesktopSettingKeySchema } from "@zcode/shared";
import {
  APP_DESKTOP_SETTING_KEYS,
  APPEARANCE_DESKTOP_SETTING_KEYS,
  DESKTOP_SETTING_KEYS,
  DESKTOP_SETTING_SCOPE,
  DESKTOP_SETTING_VALUE_SCHEMAS,
  desktopSettingKeySchema,
} from "../../src/interfaces/desktop-settings.port.js";
import {
  GET_DESKTOP_SETTING_TOOL_NAME,
  SET_DESKTOP_SETTING_TOOL_NAME,
  GetDesktopSettingInputJsonSchema,
  GetDesktopSettingInputSchema,
  GetDesktopSettingOutputSchema,
  SetDesktopSettingInputJsonSchema,
  SetDesktopSettingInputSchema,
  SetDesktopSettingOutputSchema,
} from "../../src/tools/desktop-setting.js";

// spec 明确排除的敏感项样本：网络出口、证书校验、快捷键、一次性迁移标记。
const SENSITIVE_EXCLUDED_KEYS = [
  "httpProxy",
  "httpProxyNoProxy",
  "httpProxyCaCertPath",
  "embeddedBrowserAllowInsecureCertificates",
  "shortcutBindings",
  "closeToTrayOnWindowsMigrationInitialized",
] as const;

test("whitelist covers exactly the spec keys with correct scope split", () => {
  assert.deepEqual(APP_DESKTOP_SETTING_KEYS, ["locale"]);
  assert.deepEqual(APPEARANCE_DESKTOP_SETTING_KEYS, ["theme", "notifications.enabled"]);
  assert.deepEqual([...DESKTOP_SETTING_KEYS].sort(), [
    "default_model",
    "locale",
    "notifications.enabled",
    "theme",
  ]);
  for (const key of APP_DESKTOP_SETTING_KEYS) {
    assert.equal(DESKTOP_SETTING_SCOPE[key], "app");
  }
  assert.equal(DESKTOP_SETTING_SCOPE.theme, "appearance");
  assert.equal(DESKTOP_SETTING_SCOPE["notifications.enabled"], "appearance");
  assert.equal(DESKTOP_SETTING_SCOPE.default_model, "model");
});

test("contracts whitelist keys stay in sync with the shared protocol whitelist", () => {
  const sharedKeys = zcodeDesktopSettingKeySchema.options;
  assert.deepEqual([...sharedKeys].sort(), [...DESKTOP_SETTING_KEYS].sort());
});

test("valid keys and values parse for get and set inputs", () => {
  for (const key of DESKTOP_SETTING_KEYS) {
    assert.equal(GetDesktopSettingInputSchema.safeParse({ key }).success, true, key);
  }
  const validAssignments = [
    { key: "locale", value: "zh-CN" },
    { key: "locale", value: "en-US" },
    { key: "theme", value: "light" },
    { key: "theme", value: "dark" },
    { key: "theme", value: "system" },
    { key: "notifications.enabled", value: false },
    { key: "notifications.enabled", value: true },
    { key: "default_model", value: { providerId: "p-1", modelId: "glm-5.3" } },
  ];
  for (const assignment of validAssignments) {
    assert.equal(SetDesktopSettingInputSchema.safeParse(assignment).success, true);
  }
});

test("sensitive keys outside the whitelist are rejected by both tools", () => {
  for (const key of SENSITIVE_EXCLUDED_KEYS) {
    assert.equal(GetDesktopSettingInputSchema.safeParse({ key }).success, false, key);
    assert.equal(desktopSettingKeySchema.safeParse(key).success, false, key);
    const setAttempt = SetDesktopSettingInputSchema.safeParse({ key, value: "x" });
    assert.equal(setAttempt.success, false, key);
  }
});

test("values not matching the per-key schema are rejected", () => {
  const invalidAssignments = [
    { key: "locale", value: "fr-FR" },
    { key: "locale", value: true },
    { key: "theme", value: "blue" },
    { key: "theme", value: 1 },
    { key: "notifications.enabled", value: "yes" },
    { key: "default_model", value: { providerId: "", modelId: "glm-5.3" } },
    { key: "default_model", value: "glm-5.3" },
    { key: "locale", value: "en-US", extra: 1 },
  ];
  for (const assignment of invalidAssignments) {
    assert.equal(SetDesktopSettingInputSchema.safeParse(assignment).success, false);
    // 按 key 的 value Schema 同样拒绝（宿主端口转发前的第二把尺）。
    if ("value" in assignment) {
      const valueCheck = DESKTOP_SETTING_VALUE_SCHEMAS[
        assignment.key as keyof typeof DESKTOP_SETTING_VALUE_SCHEMAS
      ]?.safeParse(assignment.value);
      if (assignment.extra === undefined) {
        assert.equal(valueCheck?.success ?? true, false);
      }
    }
  }
});

test("app-scope assignments stay consistent with settingService's appSettingsPatchSchema", () => {
  // handler → 端口 → settingService.update 的值域一致性：scope=app 现仅 locale。
  const consistentAssignments = [{ locale: "en-US" }];
  for (const patch of consistentAssignments) {
    assert.equal(appSettingsPatchSchema.safeParse(patch).success, true);
    assert.deepEqual(appSettingsPatchSchema.parse(patch), patch);
  }
  // 契约尺拒绝的非法值在 settingService 尺下同样被拒（如 locale 越界枚举）。
  assert.equal(appSettingsPatchSchema.safeParse({ locale: "fr-FR" }).success, false);
  // theme/notifications.enabled/default_model 都不是 AppSettings 字段：patch schema 会
  // 静默剥掉它们（非 strict），证明这些 scope 绝不能走 settingService，只能走
  // renderer setter 链路 / 模型选择仓库等各自唯一写路径。
  assert.deepEqual(appSettingsPatchSchema.parse({ theme: "dark" } as never), {});
});

test("tool names follow the spec naming", () => {
  assert.equal(GET_DESKTOP_SETTING_TOOL_NAME, "get_desktop_setting");
  assert.equal(SET_DESKTOP_SETTING_TOOL_NAME, "set_desktop_setting");
});

test("output shapes: snapshot for get, applied literal true for set", () => {
  const snapshot = GetDesktopSettingOutputSchema.safeParse({
    key: "theme",
    value: "dark",
    scope: "appearance",
  });
  assert.equal(snapshot.success, true);
  assert.equal(
    GetDesktopSettingOutputSchema.safeParse({ key: "theme", value: "dark", scope: "web" })
      .success,
    false,
  );
  const applied = SetDesktopSettingOutputSchema.safeParse({
    key: "locale",
    value: "en-US",
    applied: true,
  });
  assert.equal(applied.success, true);
  // 不存在 applied:false 的半成功形状：失败走 CoreError，不进 output。
  assert.equal(
    SetDesktopSettingOutputSchema.safeParse({ key: "locale", value: "en-US", applied: false })
      .success,
    false,
  );
  // provider 面 JSON Schema 可序列化且为对象。
  assert.equal(typeof GetDesktopSettingInputJsonSchema, "object");
  assert.equal(typeof SetDesktopSettingInputJsonSchema, "object");
});
