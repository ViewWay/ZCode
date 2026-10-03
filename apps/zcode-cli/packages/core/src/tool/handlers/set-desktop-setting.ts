// ============================================================
// SetDesktopSetting Handler - set_desktop_setting（agent 可调桌面设置）
// ============================================================
// specs/agent-settings.md：模型在白名单内写桌面设置。写入路径唯一——
// 端口实现按 scope 路由到既有所有者（app → settingService 唯一路径；
// appearance → renderer 主题 setter 链路），本工具不建第二状态源。
// 权限：set 默认 ask（metadata.needsApproval + permission 声明），由 executor 的
// permissionBroker 兑现，handler 内不发明第二条确认通道。
// 白名单外 key / value 不合按 key Schema 在入参 discriminated union 即被拒
// （可读枚举错误），不存在部分写入；宿主写入失败向上抛错翻译为 CoreError。

import {
  CoreErrorType,
  createCoreError,
  SET_DESKTOP_SETTING_TOOL_NAME,
  SetDesktopSettingInputJsonSchema,
  SetDesktopSettingInputSchema,
  SetDesktopSettingOutputJsonSchema,
  SetDesktopSettingOutputSchema,
  DESKTOP_SETTING_MODEL_BYTES,
  DESKTOP_SETTING_TIMEOUT_MS,
  type SetDesktopSettingInput,
  type SetDesktopSettingOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { requireDesktopSettingsPort } from "./get-desktop-setting.js";

const SET_DESKTOP_SETTING_DESCRIPTION = [
  "# set_desktop_setting",
  "",
  "Change one whitelisted desktop setting of this app instance. The user is asked for confirmation before it is applied.",
  "",
  "```json",
  '{ "key": "theme", "value": "dark" }',
  "```",
  "",
  "Allowed assignments:",
  "- `locale`: `\"zh-CN\"` | `\"en-US\"`",
  "- `theme`: `\"light\"` | `\"dark\"` | `\"system\"`",
  "- `notifications.enabled`: boolean",
  '- `default_model`: `{ "providerId": "...", "modelId": "..." }`',
  "",
  "Anything else (proxy, certificates, shortcuts, deep appearance customization, ...) is outside the whitelist and always rejected.",
].join("\n");

const setDesktopSettingHandler: ToolHandler = async (input, context) => {
  const parsed = SetDesktopSettingInputSchema.parse(input) as SetDesktopSettingInput;
  requireDesktopSettingsPort(context, SET_DESKTOP_SETTING_TOOL_NAME);
  // 契约层已按 key 校验过 value；宿主写入失败以抛错上浮，由 executor 翻译给模型。
  const snapshot = await context.desktopSettingsPort.set(parsed.key, parsed.value);
  if (snapshot.key !== parsed.key) {
    // 端口回写 key 与请求不一致属接线故障：不能让模型以为已改 A 而实际改了 B。
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      `DesktopSettingsPort wrote ${snapshot.key} while ${SET_DESKTOP_SETTING_TOOL_NAME} requested ${parsed.key}`,
      {
        context: { requestedKey: parsed.key, appliedKey: snapshot.key },
        recoverable: false,
        retryable: false,
      },
    );
  }
  return SetDesktopSettingOutputSchema.parse({
    key: snapshot.key,
    value: snapshot.value,
    applied: true,
  }) satisfies SetDesktopSettingOutput;
};

function formatSetDesktopSettingModelContent(output: unknown): string {
  const parsed = SetDesktopSettingOutputSchema.safeParse(output);
  if (!parsed.success) return "set_desktop_setting returned an invalid result.";
  return `desktop setting ${parsed.data.key} is now ${JSON.stringify(parsed.data.value)}`;
}

export const setDesktopSettingToolEntry: ToolEntry = {
  capability: "Change one whitelisted desktop setting of this app instance",
  metadata: {
    name: SET_DESKTOP_SETTING_TOOL_NAME,
    description: SET_DESKTOP_SETTING_DESCRIPTION,
    modelInstructions: [
      "Only call this when the user explicitly asks to change one of the whitelisted desktop settings.",
      "The write goes through the app's single settings owner; after a successful call, do not verify by re-reading unless the user asks.",
      "If the call is rejected as outside the whitelist (proxy, certificates, shortcuts, ...), relay that limit to the user instead of retrying with other keys.",
    ],
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: DESKTOP_SETTING_TIMEOUT_MS,
    maxOutputBytes: DESKTOP_SETTING_MODEL_BYTES,
    sideEffectScope: "system",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: setDesktopSettingHandler,
  formatModelContent: formatSetDesktopSettingModelContent,
  inputSchema: SetDesktopSettingInputJsonSchema,
  outputSchema: SetDesktopSettingOutputJsonSchema,
  runtimeInputSchema: SetDesktopSettingInputSchema,
  runtimeOutputSchema: SetDesktopSettingOutputSchema,
  permission: {
    permission: "desktop.settings.write",
    reason:
      "set_desktop_setting changes one whitelisted app setting (locale, message stream toggles, auto-archive, theme)",
    riskLevel: "medium",
    sideEffectScope: "system",
    needsApproval: true,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: DESKTOP_SETTING_MODEL_BYTES,
    maxModelBytes: DESKTOP_SETTING_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: DESKTOP_SETTING_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: DESKTOP_SETTING_TIMEOUT_MS,
    maxMs: DESKTOP_SETTING_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "set_desktop_setting was cancelled before the setting was applied",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
