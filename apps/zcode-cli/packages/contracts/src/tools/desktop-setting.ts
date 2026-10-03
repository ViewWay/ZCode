// ============================================================
// Desktop Setting Tools - get_desktop_setting / set_desktop_setting 工具契约
// ============================================================
// 对齐 MiMo 同名功能（specs/agent-settings.md）：模型在枚举白名单内读写桌面设置。
// set 的入参是按 key 判别的联合（discriminated union）：白名单外 key 或 value
// 不合按 key Schema 时在入参层即被拒（zod 可读枚举错误，不落部分写入）。
// 敏感项（httpProxy*、证书校验、快捷键、*MigrationInitialized）不在值域内。
// get 只读不确认；set 默认 permission ask（见 core handler 的 permission 声明）。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import {
  DESKTOP_SETTING_VALUE_SCHEMAS,
  desktopSettingKeySchema,
} from "../interfaces/desktop-settings.port.js";

export const GET_DESKTOP_SETTING_TOOL_NAME = "get_desktop_setting";
export const SET_DESKTOP_SETTING_TOOL_NAME = "set_desktop_setting";

/** 单键读写结果的回灌预算；设置项输出极小，给一档宽松上限。 */
export const DESKTOP_SETTING_MODEL_BYTES = 8_192;
/** 宿主往返 + 设置写队列的默认超时。 */
export const DESKTOP_SETTING_TIMEOUT_MS = 15_000;

const desktopSettingScopeSchema = z.enum(["app", "appearance"]);
const desktopSettingValueSchema = z.union([z.string(), z.boolean()]);

// ── get_desktop_setting ──────────────────────────────────────

export const GetDesktopSettingInputSchema = z
  .object({
    key: desktopSettingKeySchema.describe(
      "Setting key to read. Allowed: locale, messageStreamShowReasoning, " +
        "messageStreamShowTodos, taskAutoArchiveEnabled, theme.",
    ),
  })
  .strict();
export type GetDesktopSettingInput = z.infer<typeof GetDesktopSettingInputSchema>;

export const GetDesktopSettingOutputSchema = z
  .object({
    key: desktopSettingKeySchema,
    value: desktopSettingValueSchema,
    scope: desktopSettingScopeSchema,
  })
  .strict();
export type GetDesktopSettingOutput = z.infer<typeof GetDesktopSettingOutputSchema>;

export const GetDesktopSettingInputJsonSchema = toToolJsonSchema(GetDesktopSettingInputSchema);
export const GetDesktopSettingOutputJsonSchema = toToolJsonSchema(GetDesktopSettingOutputSchema);

// ── set_desktop_setting ──────────────────────────────────────

/** 按 key 判别的赋值联合：key 与 value 的合法组合在 schema 层一次定死。 */
export const SetDesktopSettingInputSchema = z.discriminatedUnion("key", [
  z
    .object({ key: z.literal("locale"), value: DESKTOP_SETTING_VALUE_SCHEMAS.locale })
    .strict(),
  z
    .object({ key: z.literal("theme"), value: DESKTOP_SETTING_VALUE_SCHEMAS.theme })
    .strict(),
  z
    .object({
      key: z.literal("notifications.enabled"),
      value: DESKTOP_SETTING_VALUE_SCHEMAS["notifications.enabled"],
    })
    .strict(),
  z
    .object({
      key: z.literal("default_model"),
      value: DESKTOP_SETTING_VALUE_SCHEMAS.default_model,
    })
    .strict(),
]);
export type SetDesktopSettingInput = z.infer<typeof SetDesktopSettingInputSchema>;

export const SetDesktopSettingOutputSchema = z
  .object({
    key: desktopSettingKeySchema,
    value: desktopSettingValueSchema,
    /** 写入路径唯一且成功才返回；失败走 CoreError，不存在 applied:false 的半成功。 */
    applied: z.literal(true),
  })
  .strict();
export type SetDesktopSettingOutput = z.infer<typeof SetDesktopSettingOutputSchema>;

export const SetDesktopSettingInputJsonSchema = toToolJsonSchema(SetDesktopSettingInputSchema);
export const SetDesktopSettingOutputJsonSchema = toToolJsonSchema(SetDesktopSettingOutputSchema);
