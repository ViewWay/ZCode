import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent } from "@/components/ui/card.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  computeEffectiveThemeColors,
  type AppearanceMode,
  type AppearancePreferences,
} from "@/lib/appearancePreferences.js";
import { MAX_UI_FONT_SIZE_PX, MIN_UI_FONT_SIZE_PX } from "@/lib/uiFontSize.js";
import { CodePreviewSettingsContent, FontSizeInput } from "@/settingsCodePreview.js";
import { ThemeCustomizeCard } from "@/settings/appearanceThemeCard.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { THEME_MODES } from "@/settings/settingsPageConfig.js";
import { resolveTheme, type Theme } from "@/useTheme.js";
import type { CodePreviewSettings } from "@/store/index.js";

// ============================================================================
// 外观预览
// ============================================================================

function AppearancePreview({
  preferences,
  resolvedTheme,
}: {
  preferences: AppearancePreferences;
  resolvedTheme: "light" | "dark";
}) {
  const { intl } = useZCodeIntl();
  const [sampleMode, setSampleMode] = useState<"code" | "text">("code");
  const mode: AppearanceMode = resolvedTheme === "dark" ? "dark" : "light";
  const effective = useMemo(
    () => computeEffectiveThemeColors(preferences, mode),
    [preferences, mode],
  );
  const previewStyle = {
    backgroundColor: effective.background,
    color: effective.foreground,
    fontFamily: preferences.codeFontFamily || "var(--font-mono)",
    fontSize: "13px",
    lineHeight: "22px",
  } satisfies CSSProperties;

  const codeLines = [
    "const theme = {",
    `  accent: "${effective.accent}",`,
    `  background: "${effective.background}",`,
    `  foreground: "${effective.foreground}",`,
    "  translucentSidebar: " + String(preferences.translucentSidebar) + ",",
    "};",
  ];

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <div className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.appearance.previewTitle" })}
        </div>
        <Button
          variant={sampleMode === "text" ? "default" : "ghost"}
          size="sm"
          aria-label={intl.formatMessage({ id: "settings.appearance.previewToggle" })}
          onClick={() => setSampleMode(sampleMode === "code" ? "text" : "code")}
        >
          Aa
        </Button>
      </div>
      <div className="p-3">
        <div style={previewStyle} className="rounded-lg px-4 py-3">
          {sampleMode === "code" ? (
            <div className="font-mono">
              {codeLines.map((line, index) => (
                <div key={index} className="flex gap-4">
                  <span
                    className="w-4 shrink-0 select-none text-right tabular-nums"
                    style={{ color: effective.foregroundSubtlest }}
                  >
                    {index + 1}
                  </span>
                  <span className="whitespace-pre">{line}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontFamily: preferences.uiFontFamily || "var(--font-sans)" }}>
              <div className="text-3xl font-semibold">Aa</div>
              <div className="mt-1 text-ui-sm" style={{ color: effective.foregroundSubtle }}>
                The quick brown fox jumps over the lazy dog.
                <br />
                敏捷的棕色狐狸跳过懒狗。
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 分区入口
// ============================================================================

export function AppearanceSectionContent({
  codePreviewSettings,
  setCodePreviewSettings,
  theme,
  setTheme,
  uiFontSizePx,
  setUiFontSizePx,
  appearancePreferences,
  setAppearancePreferences,
}: {
  codePreviewSettings: CodePreviewSettings;
  setCodePreviewSettings: (settings: Partial<CodePreviewSettings>) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  uiFontSizePx: number;
  setUiFontSizePx: (fontSizePx: number) => void;
  appearancePreferences: AppearancePreferences;
  setAppearancePreferences: (patch: Partial<AppearancePreferences>) => void;
}) {
  const { intl } = useZCodeIntl();
  const resolvedTheme = resolveTheme(theme);

  return (
    <>
      <div className="min-w-0 space-y-3">
        <div>
          <h3 className="text-ui-lg font-semibold text-foreground">
            {intl.formatMessage({ id: "settings.appearance.interfaceTitle" })}
          </h3>
          <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: "settings.appearance.interfaceDescription" })}
          </p>
        </div>
        <Card className="border border-border bg-card py-0 shadow-none">
          <CardContent className="space-y-0 px-0">
            <SettingsRow
              label={intl.formatMessage({ id: "settings.themeMode" })}
              description={intl.formatMessage({ id: "settings.themeModeDescription" })}
              control={
                <Select value={theme} onValueChange={(value) => setTheme(value as Theme)}>
                  <SelectTrigger size="lg" className="w-[260px] min-w-0 justify-between">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {THEME_MODES.map(({ mode, icon: Icon }) => (
                      <SelectItem key={mode} value={mode}>
                        <div className="flex items-center gap-2">
                          <Icon className="size-4" />
                          {intl.formatMessage({ id: `settings.themeMode.${mode}` })}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
            <SettingsRow
              label={intl.formatMessage({ id: "settings.uiFontSize" })}
              description={intl.formatMessage({ id: "settings.uiFontSizeDescription" })}
              control={
                <FontSizeInput
                  key={uiFontSizePx}
                  min={MIN_UI_FONT_SIZE_PX}
                  max={MAX_UI_FONT_SIZE_PX}
                  value={uiFontSizePx}
                  onChange={setUiFontSizePx}
                  ariaLabel={intl.formatMessage({ id: "settings.uiFontSize" })}
                />
              }
            />
          </CardContent>
        </Card>
      </div>

      <AppearancePreview preferences={appearancePreferences} resolvedTheme={resolvedTheme} />

      <ThemeCustomizeCard
        mode="light"
        title={intl.formatMessage({ id: "settings.appearance.customizeLightTitle" })}
        preferences={appearancePreferences}
        onPatch={setAppearancePreferences}
      />
      <ThemeCustomizeCard
        mode="dark"
        title={intl.formatMessage({ id: "settings.appearance.customizeDarkTitle" })}
        preferences={appearancePreferences}
        onPatch={setAppearancePreferences}
      />

      <CodePreviewSettingsContent
        codePreviewSettings={codePreviewSettings}
        setCodePreviewSettings={setCodePreviewSettings}
        activePreviewMode={resolvedTheme}
      />

      <div className="min-w-0 space-y-3">
        <h3 className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.appearance.preferencesTitle" })}
        </h3>
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.appearance.pointerCursor" })}
            description={intl.formatMessage({ id: "settings.appearance.pointerCursorDescription" })}
            control={
              <Switch
                checked={appearancePreferences.pointerCursor}
                onCheckedChange={(pointerCursor) => setAppearancePreferences({ pointerCursor })}
              />
            }
          />
        </SettingsGroupCard>
      </div>
    </>
  );
}
