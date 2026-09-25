import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent } from "@/components/ui/card.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  BUILTIN_THEME_REFERENCE,
  buildPresetPatch,
  computeEffectiveThemeColors,
  getThemePreset,
  parseAppearanceTheme,
  serializeAppearanceTheme,
  type AppearanceMode,
  type AppearancePreferences,
  type AppearanceThemePreset,
} from "@/lib/appearancePreferences.js";
import { ContrastSlider } from "@/settings/appearanceControls.js";
import { ColorRow, SharedAppearanceRows } from "@/settings/appearanceSharedRows.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";

function ImportThemeDialog({
  open,
  onOpenChange,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (text: string) => string | null;
}) {
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState("");
  const [errorId, setErrorId] = useState<string | null>(null);

  const handleClose = (next: boolean) => {
    if (!next) {
      setDraft("");
      setErrorId(null);
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "settings.appearance.importDialogTitle" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.appearance.importDialogDescription" })}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={draft}
          spellCheck={false}
          placeholder={intl.formatMessage({ id: "settings.appearance.importDialogPlaceholder" })}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setErrorId(null);
          }}
          className="h-40 font-mono text-ui-sm"
        />
        {errorId ? (
          <p className="text-ui-sm text-destructive">{intl.formatMessage({ id: errorId })}</p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)}>
            {intl.formatMessage({ id: "settings.appearance.importDialogCancel" })}
          </Button>
          <Button
            onClick={() => {
              const error = onApply(draft);
              if (error) {
                setErrorId(error);
                return;
              }
              handleClose(false);
            }}
          >
            {intl.formatMessage({ id: "settings.appearance.importDialogApply" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Codex 式主题自定义卡：预设/导入/复制 + 颜色、字体、侧边栏与对比度设置。 */
export function ThemeCustomizeCard({
  mode,
  title,
  preferences,
  onPatch,
}: {
  mode: AppearanceMode;
  title: string;
  preferences: AppearancePreferences;
  onPatch: (patch: Partial<AppearancePreferences>) => void;
}) {
  const { intl } = useZCodeIntl();
  const [importOpen, setImportOpen] = useState(false);
  const colors = preferences[mode];
  const contrast = mode === "light" ? preferences.lightContrast : preferences.darkContrast;
  const preset = getThemePreset(colors);
  const effective = useMemo(
    () => computeEffectiveThemeColors(preferences, mode),
    [preferences, mode],
  );
  const reference = BUILTIN_THEME_REFERENCE[mode];

  const handlePresetChange = (next: string) => {
    if (next === "custom") {
      return;
    }
    const { colors: presetColors, contrast: presetContrast } = buildPresetPatch(
      mode,
      next as Exclude<AppearanceThemePreset, "custom">,
    );
    onPatch(
      mode === "light"
        ? { light: presetColors, lightContrast: presetContrast }
        : { dark: presetColors, darkContrast: presetContrast },
    );
  };

  const handleAccentSourceChange = (source: "default" | "custom") => {
    // 切到自定义时用内置强调色作为起点，避免从空白开始。
    const accent = source === "custom" ? reference.accent : null;
    onPatch(mode === "light" ? { light: { ...colors, accent } } : { dark: { ...colors, accent } });
  };

  const handleCopyTheme = async () => {
    const json = serializeAppearanceTheme(mode, preferences);
    try {
      await navigator.clipboard.writeText(json);
    } catch (error) {
      logger.warn("[Appearance] 复制主题到剪贴板失败", error);
    }
  };

  const handleImportApply = (text: string): string | null => {
    const parsed = parseAppearanceTheme(text);
    if (!parsed.ok) {
      return parsed.errorId;
    }
    onPatch(
      parsed.mode === "light"
        ? { light: parsed.colors, lightContrast: parsed.contrast }
        : { dark: parsed.colors, darkContrast: parsed.contrast },
    );
    return null;
  };

  const contrastKey = mode === "light" ? "lightContrast" : "darkContrast";

  return (
    <Card className="border border-border bg-card py-0 shadow-none">
      <CardContent className="space-y-0 px-0">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <div className="text-ui-base font-semibold text-foreground">{title}</div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)}>
              {intl.formatMessage({ id: "settings.appearance.importTheme" })}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void handleCopyTheme()}>
              {intl.formatMessage({ id: "settings.appearance.copyTheme" })}
            </Button>
            <Select value={preset} onValueChange={handlePresetChange}>
              <SelectTrigger size="lg" className="w-[132px] justify-between">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">
                  {intl.formatMessage({ id: "settings.appearance.preset.default" })}
                </SelectItem>
                <SelectItem value="codex">
                  {intl.formatMessage({ id: "settings.appearance.preset.codex" })}
                </SelectItem>
                <SelectItem value="custom" disabled={preset !== "custom"}>
                  {intl.formatMessage({ id: "settings.appearance.preset.custom" })}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <ColorRow
          label={intl.formatMessage({ id: "settings.appearance.accent" })}
          color={colors.accent ?? effective.accent}
          hasOverride={colors.accent !== null}
          accentSource={colors.accent !== null ? "custom" : "default"}
          onAccentSourceChange={handleAccentSourceChange}
          onColorChange={(accent) =>
            onPatch(
              mode === "light" ? { light: { ...colors, accent } } : { dark: { ...colors, accent } },
            )
          }
          onReset={() => handleAccentSourceChange("default")}
        />
        <ColorRow
          label={intl.formatMessage({ id: "settings.appearance.background" })}
          color={colors.background ?? effective.background}
          hasOverride={colors.background !== null}
          onColorChange={(background) =>
            onPatch(
              mode === "light"
                ? { light: { ...colors, background } }
                : { dark: { ...colors, background } },
            )
          }
          onReset={() =>
            onPatch(
              mode === "light"
                ? { light: { ...colors, background: null } }
                : { dark: { ...colors, background: null } },
            )
          }
        />
        <ColorRow
          label={intl.formatMessage({ id: "settings.appearance.foreground" })}
          color={colors.foreground ?? effective.foreground}
          hasOverride={colors.foreground !== null}
          onColorChange={(foreground) =>
            onPatch(
              mode === "light"
                ? { light: { ...colors, foreground } }
                : { dark: { ...colors, foreground } },
            )
          }
          onReset={() =>
            onPatch(
              mode === "light"
                ? { light: { ...colors, foreground: null } }
                : { dark: { ...colors, foreground: null } },
            )
          }
        />
        <SharedAppearanceRows preferences={preferences} onPatch={onPatch} />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.appearance.contrast" })}
          control={
            <ContrastSlider
              value={contrast}
              ariaLabel={intl.formatMessage({ id: "settings.appearance.contrast" })}
              onChange={(value) => onPatch({ [contrastKey]: value })}
            />
          }
        />
        <ImportThemeDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          onApply={handleImportApply}
        />
      </CardContent>
    </Card>
  );
}
