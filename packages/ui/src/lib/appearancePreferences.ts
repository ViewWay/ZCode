/**
 * 外观偏好（Codex 式主题自定义）纯逻辑层：类型、默认值、预设、颜色数学与序列化。
 * DOM 应用见 appearanceThemeApply.ts；状态写入唯一入口在 store/index.ts。
 */
import { readSafeLocalStorage } from "@/lib/browserEnvironment.js";

export type AppearanceHexColor = string;

export interface ThemeAppearanceColors {
  /** null = 跟随内置主题 */
  accent: string | null;
  background: string | null;
  foreground: string | null;
}

export type AppearanceFontWeight = 400 | 500 | 600;

export interface AppearancePreferences {
  light: ThemeAppearanceColors;
  dark: ThemeAppearanceColors;
  lightContrast: number;
  darkContrast: number;
  uiFontFamily: string;
  uiFontWeight: AppearanceFontWeight;
  contentFontFamily: string;
  contentFontWeight: AppearanceFontWeight;
  codeFontFamily: string;
  codeFontWeight: AppearanceFontWeight;
  translucentSidebar: boolean;
  pointerCursor: boolean;
}

export type AppearanceMode = "light" | "dark";
export type AppearanceThemePreset = "default" | "codex" | "custom";

export const APPEARANCE_PREFERENCES_STORAGE_KEY = "zcode-appearance-preferences";

/** styles.css 内置 zai 主题的参照值，用于 null 回落与预览展示（只读）。 */
export const BUILTIN_THEME_REFERENCE: Record<
  AppearanceMode,
  { accent: string; background: string; foreground: string }
> = {
  light: { accent: "#000000", background: "#f8f8f8", foreground: "#262626" },
  dark: { accent: "#ffffff", background: "#161616", foreground: "#d4d4d4" },
};

/** Codex 截图同款预设值。 */
export const CODEX_THEME_PRESET: Record<
  AppearanceMode,
  ThemeAppearanceColors & { contrast: number }
> = {
  light: { accent: "#339CFF", background: "#FFFFFF", foreground: "#1A1C1F", contrast: 51 },
  dark: { accent: "#0169CC", background: "#111111", foreground: "#FCFCFC", contrast: 60 },
};

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  light: { accent: null, background: null, foreground: null },
  dark: { accent: null, background: null, foreground: null },
  lightContrast: 50,
  darkContrast: 50,
  uiFontFamily: "",
  uiFontWeight: 400,
  contentFontFamily: "",
  contentFontWeight: 400,
  codeFontFamily: "",
  codeFontWeight: 400,
  translucentSidebar: false,
  pointerCursor: false,
};

export interface AppearanceFontOption {
  value: string;
  labelId: string;
}

const SANS_STACK =
  "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', 'Noto Sans CJK SC', sans-serif";
const SERIF_STACK = "Georgia, 'Times New Roman', 'Songti SC', 'SimSun', serif";
const MONO_UI_STACK = "'SF Mono', Menlo, Consolas, 'PingFang SC', 'Microsoft YaHei UI', monospace";

export const APPEARANCE_UI_FONT_OPTIONS: AppearanceFontOption[] = [
  { value: "", labelId: "settings.appearance.fontOption.system" },
  { value: SANS_STACK, labelId: "settings.appearance.fontOption.sans" },
  { value: SERIF_STACK, labelId: "settings.appearance.fontOption.serif" },
  { value: MONO_UI_STACK, labelId: "settings.appearance.fontOption.mono" },
];

export const APPEARANCE_CONTENT_FONT_OPTIONS: AppearanceFontOption[] = [
  { value: "", labelId: "settings.appearance.fontOption.sameAsUi" },
  ...APPEARANCE_UI_FONT_OPTIONS.filter((option) => option.value !== ""),
];

export const APPEARANCE_CODE_FONT_OPTIONS: AppearanceFontOption[] = [
  { value: "", labelId: "settings.appearance.fontOption.system" },
  { value: "Menlo, 'SF Mono', monospace", labelId: "settings.appearance.codeFontOption.menlo" },
  {
    value: "Consolas, 'Cascadia Mono', monospace",
    labelId: "settings.appearance.codeFontOption.consolas",
  },
  {
    value: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace",
    labelId: "settings.appearance.codeFontOption.cascadia",
  },
  {
    value: "'JetBrains Mono', Menlo, Consolas, monospace",
    labelId: "settings.appearance.codeFontOption.jetbrains",
  },
  {
    value: "'Fira Code', 'Fira Mono', Menlo, Consolas, monospace",
    labelId: "settings.appearance.codeFontOption.fira",
  },
];

export const APPEARANCE_FONT_WEIGHT_OPTIONS: AppearanceFontWeight[] = [400, 500, 600];

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value);
}

/** 统一为 #RRGGBB 大写形式，便于展示与预设比对。 */
export function normalizeHexColor(value: string): string {
  return `#${value.slice(1).toUpperCase()}`;
}

export function clampContrast(value: unknown): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 50;
  return Math.min(100, Math.max(0, parsed));
}

function normalizeFontWeight(value: unknown): AppearanceFontWeight {
  return value === 500 || value === 600 ? value : 400;
}

function normalizeFontFamily(value: unknown, allowedValues: readonly string[]): string {
  return typeof value === "string" && allowedValues.includes(value) ? value : "";
}

function normalizeThemeColors(value: unknown): ThemeAppearanceColors {
  const source = (value ?? {}) as Partial<ThemeAppearanceColors>;
  const normalize = (color: unknown) => (isHexColor(color) ? normalizeHexColor(color) : null);
  return {
    accent: normalize(source.accent),
    background: normalize(source.background),
    foreground: normalize(source.foreground),
  };
}

export function normalizeAppearancePreferences(value: unknown): AppearancePreferences {
  const source = (value ?? {}) as Partial<AppearancePreferences>;
  const uiFamilies = APPEARANCE_UI_FONT_OPTIONS.map((option) => option.value);
  const contentFamilies = APPEARANCE_CONTENT_FONT_OPTIONS.map((option) => option.value);
  const codeFamilies = APPEARANCE_CODE_FONT_OPTIONS.map((option) => option.value);
  return {
    light: normalizeThemeColors(source.light),
    dark: normalizeThemeColors(source.dark),
    lightContrast: clampContrast(source.lightContrast),
    darkContrast: clampContrast(source.darkContrast),
    uiFontFamily: normalizeFontFamily(source.uiFontFamily, uiFamilies),
    uiFontWeight: normalizeFontWeight(source.uiFontWeight),
    contentFontFamily: normalizeFontFamily(source.contentFontFamily, contentFamilies),
    contentFontWeight: normalizeFontWeight(source.contentFontWeight),
    codeFontFamily: normalizeFontFamily(source.codeFontFamily, codeFamilies),
    codeFontWeight: normalizeFontWeight(source.codeFontWeight),
    translucentSidebar: source.translucentSidebar === true,
    pointerCursor: source.pointerCursor === true,
  };
}

export function loadAppearancePreferences(): AppearancePreferences {
  if (typeof window === "undefined") {
    return DEFAULT_APPEARANCE_PREFERENCES;
  }
  try {
    const raw = readSafeLocalStorage(APPEARANCE_PREFERENCES_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_APPEARANCE_PREFERENCES;
    }
    return normalizeAppearancePreferences(JSON.parse(raw));
  } catch {
    return DEFAULT_APPEARANCE_PREFERENCES;
  }
}

// ============================================================================
// 主题预设
// ============================================================================

export function getThemePreset(colors: ThemeAppearanceColors): AppearanceThemePreset {
  const isEmpty =
    colors.accent === null && colors.background === null && colors.foreground === null;
  const matches = (value: ThemeAppearanceColors, preset: ThemeAppearanceColors) =>
    value.accent === preset.accent &&
    value.background === preset.background &&
    value.foreground === preset.foreground;
  if (isEmpty) {
    return "default";
  }
  if (matches(colors, CODEX_THEME_PRESET.light) || matches(colors, CODEX_THEME_PRESET.dark)) {
    return "codex";
  }
  return "custom";
}

/** 应用预设返回该模式的颜色 + 对比度补丁；default 即清空自定义。 */
export function buildPresetPatch(
  mode: AppearanceMode,
  preset: Exclude<AppearanceThemePreset, "custom">,
): { colors: ThemeAppearanceColors; contrast: number } {
  if (preset === "default") {
    return {
      colors: { accent: null, background: null, foreground: null },
      contrast: 50,
    };
  }
  const codex = CODEX_THEME_PRESET[mode];
  return {
    colors: { accent: codex.accent, background: codex.background, foreground: codex.foreground },
    contrast: codex.contrast,
  };
}

// ============================================================================
// 颜色数学（sRGB）
// ============================================================================

interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): Rgb {
  const value = hex.replace("#", "");
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const toHex = (channel: number) =>
    Math.min(255, Math.max(0, Math.round(channel)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** t=0 返回 a，t=1 返回 b。 */
export function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const clamped = Math.min(1, Math.max(0, t));
  return rgbToHex({
    r: ca.r + (cb.r - ca.r) * clamped,
    g: ca.g + (cb.g - ca.g) * clamped,
    b: ca.b + (cb.b - ca.b) * clamped,
  });
}

function rgbaString(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 对比度映射：t = (contrast - 50) / 50 ∈ [-1, 1]。
 * t > 0 时背景/前景各自向纯端点混合（浅色 → #FFFFFF/#000000，深色 → #000000/#FFFFFF）；
 * t < 0 时背景与前景互相靠近（降低对比）。50 表示完全使用所选颜色。
 */
export function applyContrast(
  mode: AppearanceMode,
  colors: { background: string; foreground: string },
  contrast: number,
): { background: string; foreground: string } {
  const t = (clampContrast(contrast) - 50) / 50;
  if (t === 0) {
    return colors;
  }
  if (t > 0) {
    const bgExtreme = mode === "light" ? "#FFFFFF" : "#000000";
    const fgExtreme = mode === "light" ? "#000000" : "#FFFFFF";
    return {
      background: mixHex(colors.background, bgExtreme, t * 0.5),
      foreground: mixHex(colors.foreground, fgExtreme, t * 0.5),
    };
  }
  const pull = -t * 0.25;
  return {
    background: mixHex(colors.background, colors.foreground, pull),
    foreground: mixHex(colors.foreground, colors.background, pull),
  };
}

export interface EffectiveThemeColors {
  background: string;
  backgroundWinAlt: string;
  backgroundAlt: string;
  header: string;
  panel: string;
  sidebar: string;
  card: string;
  popover: string;
  input: string;
  foreground: string;
  foregroundSubtle: string;
  foregroundSubtlest: string;
  accent: string;
  accentTint: string;
}

/**
 * 计算「该模式下真正生效」的主题色：
 * 1. null 回落内置参照值；2. 套对比度；3. 按 styles.css 内置比例派生表面 token。
 */
export function computeEffectiveThemeColors(
  preferences: AppearancePreferences,
  mode: AppearanceMode,
): EffectiveThemeColors {
  const themeColors = preferences[mode];
  const reference = BUILTIN_THEME_REFERENCE[mode];
  const isLight = mode === "light";
  const background = themeColors.background ?? reference.background;
  const foreground = themeColors.foreground ?? reference.foreground;
  const accent = themeColors.accent ?? reference.accent;
  const contrasted = applyContrast(
    mode,
    { background, foreground },
    isLight ? preferences.lightContrast : preferences.darkContrast,
  );
  const bg = contrasted.background;
  const fg = contrasted.foreground;
  const white = "#FFFFFF";
  const black = "#000000";
  const towardWhite = (ratio: number) => mixHex(bg, white, ratio);
  return {
    background: bg,
    backgroundWinAlt: isLight ? mixHex(bg, black, 0.04) : towardWhite(0.12),
    backgroundAlt: rgbaString(bg, 0.7),
    header: isLight ? bg : towardWhite(0.055),
    panel: isLight ? bg : towardWhite(0.055),
    sidebar: bg,
    card: isLight ? towardWhite(0.5) : towardWhite(0.12),
    popover: isLight ? towardWhite(0.5) : towardWhite(0.12),
    input: isLight ? towardWhite(0.5) : towardWhite(0.12),
    foreground: fg,
    foregroundSubtle: rgbaString(fg, 0.6),
    foregroundSubtlest: rgbaString(fg, isLight ? 0.4 : 0.3),
    accent,
    accentTint: rgbaString(accent, isLight ? 0.12 : 0.2),
  };
}

// ============================================================================
// 导入 / 导出
// ============================================================================

const THEME_EXPORT_VERSION = 1;

export interface ExportedAppearanceTheme {
  version: number;
  mode: AppearanceMode;
  colors: ThemeAppearanceColors;
  contrast: number;
}

export function serializeAppearanceTheme(
  mode: AppearanceMode,
  preferences: AppearancePreferences,
): string {
  const exported: ExportedAppearanceTheme = {
    version: THEME_EXPORT_VERSION,
    mode,
    colors: preferences[mode],
    contrast: mode === "light" ? preferences.lightContrast : preferences.darkContrast,
  };
  return JSON.stringify(exported, null, 2);
}

export type ParseAppearanceThemeResult =
  | { ok: true; mode: AppearanceMode; colors: ThemeAppearanceColors; contrast: number }
  | { ok: false; errorId: string };

/** 校验粘贴的主题 JSON；失败返回 i18n 错误键，不抛异常。 */
export function parseAppearanceTheme(text: string): ParseAppearanceThemeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errorId: "settings.appearance.importError.invalidJson" };
  }
  const source = parsed as Partial<ExportedAppearanceTheme> | null;
  if (!source || typeof source !== "object") {
    return { ok: false, errorId: "settings.appearance.importError.invalidJson" };
  }
  if (source.version !== THEME_EXPORT_VERSION) {
    return { ok: false, errorId: "settings.appearance.importError.unsupportedVersion" };
  }
  if (source.mode !== "light" && source.mode !== "dark") {
    return { ok: false, errorId: "settings.appearance.importError.invalidMode" };
  }
  if (!source.colors) {
    return { ok: false, errorId: "settings.appearance.importError.invalidColors" };
  }
  const normalizedColors = normalizeThemeColors(source.colors);
  const hasAnyColor =
    normalizedColors.accent !== null ||
    normalizedColors.background !== null ||
    normalizedColors.foreground !== null;
  const allInputsInvalid =
    !isHexColor(source.colors.accent) &&
    source.colors.accent !== null &&
    !isHexColor(source.colors.background) &&
    source.colors.background !== null &&
    !isHexColor(source.colors.foreground) &&
    source.colors.foreground !== null;
  if (!hasAnyColor || allInputsInvalid) {
    return { ok: false, errorId: "settings.appearance.importError.invalidColors" };
  }
  return {
    ok: true,
    mode: source.mode,
    colors: normalizedColors,
    contrast: clampContrast(source.contrast ?? 50),
  };
}
