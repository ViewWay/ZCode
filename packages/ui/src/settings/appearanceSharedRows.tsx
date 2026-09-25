import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  APPEARANCE_CODE_FONT_OPTIONS,
  APPEARANCE_CONTENT_FONT_OPTIONS,
  APPEARANCE_UI_FONT_OPTIONS,
  type AppearancePreferences,
} from "@/lib/appearancePreferences.js";
import {
  ColorSwatch,
  FontFamilySelect,
  FontWeightSelect,
  HexColorInput,
} from "@/settings/appearanceControls.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 字体 + 半透明侧边栏：全局共享设置，在浅色/深色两张主题卡中重复展示，
 * 但绑定同一份状态（两卡仅是两个视图，不存在两份状态）。
 */
export function SharedAppearanceRows({
  preferences,
  onPatch,
}: {
  preferences: AppearancePreferences;
  onPatch: (patch: Partial<AppearancePreferences>) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.appearance.uiFont" })}
        control={
          <div className="flex items-center justify-end gap-2">
            <FontFamilySelect
              options={APPEARANCE_UI_FONT_OPTIONS}
              value={preferences.uiFontFamily}
              widthClassName="w-[168px]"
              ariaLabel={intl.formatMessage({ id: "settings.appearance.uiFont" })}
              onChange={(uiFontFamily) => onPatch({ uiFontFamily })}
            />
            <FontWeightSelect
              value={preferences.uiFontWeight}
              ariaLabel={intl.formatMessage({ id: "settings.appearance.uiFont" })}
              onChange={(uiFontWeight) => onPatch({ uiFontWeight })}
            />
          </div>
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.appearance.contentFont" })}
        control={
          <div className="flex items-center justify-end gap-2">
            <FontFamilySelect
              options={APPEARANCE_CONTENT_FONT_OPTIONS}
              value={preferences.contentFontFamily}
              widthClassName="w-[168px]"
              ariaLabel={intl.formatMessage({ id: "settings.appearance.contentFont" })}
              onChange={(contentFontFamily) => onPatch({ contentFontFamily })}
            />
            <FontWeightSelect
              value={preferences.contentFontWeight}
              ariaLabel={intl.formatMessage({ id: "settings.appearance.contentFont" })}
              onChange={(contentFontWeight) => onPatch({ contentFontWeight })}
            />
          </div>
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.appearance.codeFont" })}
        control={
          <div className="flex items-center justify-end gap-2">
            <FontFamilySelect
              options={APPEARANCE_CODE_FONT_OPTIONS}
              value={preferences.codeFontFamily}
              widthClassName="w-[168px]"
              ariaLabel={intl.formatMessage({ id: "settings.appearance.codeFont" })}
              onChange={(codeFontFamily) => onPatch({ codeFontFamily })}
            />
            <FontWeightSelect
              value={preferences.codeFontWeight}
              ariaLabel={intl.formatMessage({ id: "settings.appearance.codeFont" })}
              onChange={(codeFontWeight) => onPatch({ codeFontWeight })}
            />
          </div>
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.appearance.translucentSidebar" })}
        control={
          <Switch
            checked={preferences.translucentSidebar}
            onCheckedChange={(translucentSidebar) => onPatch({ translucentSidebar })}
          />
        }
      />
    </>
  );
}

export function ColorRow({
  label,
  color,
  hasOverride,
  disabled,
  accentSource,
  onAccentSourceChange,
  onColorChange,
  onReset,
}: {
  label: string;
  /** 当前生效色（含 null 回落），用于色板与 hex 输入展示。 */
  color: string;
  hasOverride: boolean;
  disabled?: boolean;
  /** 仅强调色行使用：默认/自定义来源切换；背景/前景传 undefined。 */
  accentSource?: "default" | "custom";
  onAccentSourceChange?: (source: "default" | "custom") => void;
  onColorChange?: (hex: string) => void;
  onReset?: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <SettingsRow
      label={label}
      control={
        <div className="flex items-center justify-end gap-2">
          {accentSource && onAccentSourceChange ? (
            <Select
              value={accentSource}
              onValueChange={(next) => onAccentSourceChange(next as "default" | "custom")}
            >
              <SelectTrigger size="lg" className="w-[112px] justify-between">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">
                  {intl.formatMessage({ id: "settings.appearance.accentSource.default" })}
                </SelectItem>
                <SelectItem value="custom">
                  {intl.formatMessage({ id: "settings.appearance.accentSource.custom" })}
                </SelectItem>
              </SelectContent>
            </Select>
          ) : null}
          <ColorSwatch
            color={color}
            disabled={disabled}
            ariaLabel={label}
            onChange={(hex) => onColorChange?.(hex)}
          />
          <HexColorInput
            value={color}
            disabled={disabled}
            ariaLabel={label}
            onCommit={(hex) => {
              if (hex === null) {
                onReset?.();
                return;
              }
              onColorChange?.(hex);
            }}
          />
          {hasOverride && onReset && !disabled ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={intl.formatMessage({ id: "settings.appearance.resetColor" })}
              title={intl.formatMessage({ id: "settings.appearance.resetColor" })}
              onClick={onReset}
            >
              ↺
            </Button>
          ) : null}
        </div>
      }
    />
  );
}
