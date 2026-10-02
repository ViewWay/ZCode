// ============================================================
// GetDesktopSetting Handler - get_desktop_setting（agent 可调桌面设置）
// ============================================================
// specs/agent-settings.md：模型在白名单内读取桌面设置。只读、不确认
// （needsApproval=false）。端口缺席即不注册（fail-closed）；注册门之外走到
// handler 属接线故障（照 SessionChat 的 requireSessionChatPort 模式抛
// ConfigurationError，不是一种业务结局）。白名单 key 由契约枚举保证，
// 非法 key 在入参 parse 即被拒（可读枚举错误），不可能触达端口。

import {
  CoreErrorType,
  createCoreError,
  GET_DESKTOP_SETTING_TOOL_NAME,
  GetDesktopSettingInputJsonSchema,
  GetDesktopSettingInputSchema,
  GetDesktopSettingOutputJsonSchema,
  GetDesktopSettingOutputSchema,
  DESKTOP_SETTING_MODEL_BYTES,
  DESKTOP_SETTING_TIMEOUT_MS,
  type GetDesktopSettingInput,
  type GetDesktopSettingOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const GET_DESKTOP_SETTING_DESCRIPTION = [
  "# get_desktop_setting",
  "",
  "Read one whitelisted desktop setting of this app instance.",
  "",
  "```json",
  '{ "key": "locale" }',
  "```",
  "",
  "Allowed keys: `locale`, `messageStreamShowReasoning`, `messageStreamShowTodos`, `taskAutoArchiveEnabled`, `theme`.",
  "Anything else (proxy, certificates, shortcuts, ...) is outside the whitelist and always rejected.",
].join("\n");

/**
 * 注册门以端口存在为准；走到这里说明接线故障，与 SessionChat 同款 fail-closed。
 * get/set 两个 handler 共用本守卫（set-desktop-setting.ts 导入）。
 */
export function requireDesktopSettingsPort(
  context: ToolExecutionContext,
  toolName: string,
): asserts context is ToolExecutionContext & {
  desktopSettingsPort: NonNullable<ToolExecutionContext["desktopSettingsPort"]>;
} {
  if (context.desktopSettingsPort) return;
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `DesktopSettingsPort is not configured for ${toolName}`,
    {
      context: { toolName },
      recoverable: false,
    },
  );
}

const getDesktopSettingHandler: ToolHandler = async (input, context) => {
  const parsed = GetDesktopSettingInputSchema.parse(input) as GetDesktopSettingInput;
  requireDesktopSettingsPort(context, GET_DESKTOP_SETTING_TOOL_NAME);
  const snapshot = await context.desktopSettingsPort.get(parsed.key);
  return GetDesktopSettingOutputSchema.parse({
    key: snapshot.key,
    value: snapshot.value,
    scope: snapshot.scope,
  }) satisfies GetDesktopSettingOutput;
};

function formatGetDesktopSettingModelContent(output: unknown): string {
  const parsed = GetDesktopSettingOutputSchema.safeParse(output);
  if (!parsed.success) return "get_desktop_setting returned an invalid result.";
  return `desktop setting ${parsed.data.key} (scope ${parsed.data.scope}) = ${JSON.stringify(
    parsed.data.value,
  )}`;
}

export const getDesktopSettingToolEntry: ToolEntry = {
  capability: "Read one whitelisted desktop setting of this app instance",
  metadata: {
    name: GET_DESKTOP_SETTING_TOOL_NAME,
    description: GET_DESKTOP_SETTING_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: DESKTOP_SETTING_TIMEOUT_MS,
    maxOutputBytes: DESKTOP_SETTING_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: getDesktopSettingHandler,
  formatModelContent: formatGetDesktopSettingModelContent,
  inputSchema: GetDesktopSettingInputJsonSchema,
  outputSchema: GetDesktopSettingOutputJsonSchema,
  runtimeInputSchema: GetDesktopSettingInputSchema,
  runtimeOutputSchema: GetDesktopSettingOutputSchema,
  permission: {
    permission: "desktop.settings.read",
    reason: "get_desktop_setting only reads one whitelisted setting of this app instance",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
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
    userVisibleMessage: "get_desktop_setting was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
