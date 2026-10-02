// ============================================================
// Desktop Settings Port - agent 可调桌面设置工具面的宿主能力边界
// ============================================================
// 与 SessionChatPort / SmartRoutingPort 同族：core 的 get_desktop_setting /
// set_desktop_setting 工具经此端口读写宿主桌面设置。协议宿主提供实现；
// 端口缺席即不注册工具（fail-closed）。
// 白名单是唯一事实，定义在契约层——handler 与宿主共守同一把尺：
// - scope=app：AppSettings 直映项，写经 settingService 唯一路径（specs/agent-settings.md）。
// - scope=appearance：renderer 主题 store，写经既有主题 setter 链路（广播防回环）。
// 敏感项（httpProxy*、证书校验、快捷键绑定、*MigrationInitialized 迁移标记、
// 外观深层自定义）永不入白名单；白名单外 key 在契约层即被拒绝，不依赖宿主自查。

import { z } from "zod";
import type { Locale } from "@zcode/shared";

/** scope=app：AppSettings 直映项；写经 settingService 唯一路径。 */
export const APP_DESKTOP_SETTING_KEYS = [
  "locale",
  "messageStreamShowReasoning",
  "messageStreamShowTodos",
  "taskAutoArchiveEnabled",
] as const;

/** scope=appearance：renderer 主题 store；工具面只暴露 theme 整体切换。 */
export const APPEARANCE_DESKTOP_SETTING_KEYS = ["theme"] as const;

/** 工具面可读写的白名单全集；枚举白名单而非开放 KV。 */
export const DESKTOP_SETTING_KEYS = [
  ...APP_DESKTOP_SETTING_KEYS,
  ...APPEARANCE_DESKTOP_SETTING_KEYS,
] as const;

export type DesktopSettingKey = (typeof DESKTOP_SETTING_KEYS)[number];
export type DesktopSettingScope = "app" | "appearance";

/** key → scope 映射：宿主据此路由到对应所有者（app=settingService，appearance=主题 setter）。 */
export const DESKTOP_SETTING_SCOPE: Readonly<Record<DesktopSettingKey, DesktopSettingScope>> = {
  locale: "app",
  messageStreamShowReasoning: "app",
  messageStreamShowTodos: "app",
  taskAutoArchiveEnabled: "app",
  theme: "appearance",
};

/** 与 AppSettings.locale 同值域（packages/shared protocol.ts 的 Locale）。 */
const DESKTOP_SETTING_LOCALE_VALUES = ["zh-CN", "en-US"] as const satisfies readonly Locale[];
/** 主题整体切换的合法取值；配色/字体/对比度等深层自定义不进工具面。 */
const DESKTOP_SETTING_THEME_VALUES = ["light", "dark", "system"] as const;

/** 按 key 的 value Schema：key 与 value 的合法组合在契约层一次定死。 */
export const DESKTOP_SETTING_VALUE_SCHEMAS = {
  locale: z.enum(DESKTOP_SETTING_LOCALE_VALUES),
  messageStreamShowReasoning: z.boolean(),
  messageStreamShowTodos: z.boolean(),
  taskAutoArchiveEnabled: z.boolean(),
  theme: z.enum(DESKTOP_SETTING_THEME_VALUES),
} as const satisfies Record<DesktopSettingKey, z.ZodTypeAny>;

/** 白名单 key 的联合 schema；工具入参与宿主参数校验共用同一把尺。 */
export const desktopSettingKeySchema = z.enum(DESKTOP_SETTING_KEYS);

/** 白名单内 value 的联合类型（locale/theme 为字符串枚举，其余为布尔）。 */
export type DesktopSettingValue = Locale | (typeof DESKTOP_SETTING_THEME_VALUES)[number] | boolean;

/** 一项白名单设置的当前快照；get 与 set 成功后的共同返回形状。 */
export interface DesktopSettingSnapshot {
  key: DesktopSettingKey;
  value: DesktopSettingValue;
  scope: DesktopSettingScope;
}

export interface DesktopSettingsPort {
  /** 读取一项白名单设置的当前值；key 已由契约层枚举保证合法。 */
  get(key: DesktopSettingKey): Promise<DesktopSettingSnapshot>;
  /**
   * 写入一项白名单设置；value 已由契约层按 key 校验。
   * 宿主按 scope 路由到既有唯一写路径（app → settingService.update；
   * appearance → renderer 主题 setter 链路），不建第二状态源。
   * 写入失败向上抛错（handler 翻译为可读 CoreError），不返回半成功状态。
   */
  set(key: DesktopSettingKey, value: DesktopSettingValue): Promise<DesktopSettingSnapshot>;
}
