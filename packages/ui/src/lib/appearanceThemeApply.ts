/**
 * 外观偏好的 DOM 应用层：把 computeEffectiveThemeColors 的结果写到
 * documentElement 内联 CSS 变量，并切换 html class。
 * 只被 store/index.ts 调用（setTheme / system 主题变化 / setAppearancePreferences / 初始化），
 * 保证内联变量始终匹配当前 resolved 主题，避免浅色自定义泄漏进深色模式。
 */
import {
  computeEffectiveThemeColors,
  type AppearancePreferences,
} from "@/lib/appearancePreferences.js";
import { applyTheme, resolveTheme, type ResolvedTheme, type Theme } from "@/useTheme.js";

/** 每组变量：颜色组仅在该组存在自定义（或对比度偏离 50）时写入。 */
const BACKGROUND_VARS = [
  "--color-background",
  "--color-background-alt",
  "--color-background-win-alt",
  "--color-header",
  "--color-panel",
  "--color-sidebar",
  "--color-card",
  "--color-popover",
  "--color-input",
] as const;

const FOREGROUND_VARS = [
  "--color-foreground",
  "--color-foreground-subtle",
  "--color-foreground-subtlest",
] as const;

const ACCENT_VARS = ["--color-brand", "--color-primary", "--color-accent"] as const;

function removeVars(root: HTMLElement, vars: readonly string[]) {
  for (const name of vars) {
    root.style.removeProperty(name);
  }
}

/** #RRGGBB → rgba()，供半透明表面使用。 */
function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function applyAppearanceToDocument(
  preferences: AppearancePreferences,
  resolvedTheme: ResolvedTheme,
): void {
  const root = document.documentElement;
  if (typeof document === "undefined" || typeof root?.style === "undefined") {
    return;
  }
  const mode = resolvedTheme === "dark" ? "dark" : "light";
  const themeColors = preferences[mode];
  const contrast = mode === "light" ? preferences.lightContrast : preferences.darkContrast;
  const effective = computeEffectiveThemeColors(preferences, mode);

  // 颜色组关闭时清除内联值，交还内置主题（styles.css 的 class 规则接管）。
  const backgroundActive = themeColors.background !== null || contrast !== 50;
  const foregroundActive = themeColors.foreground !== null || contrast !== 50;
  const accentActive = themeColors.accent !== null;

  if (backgroundActive) {
    // 半透明侧边栏直接把 panel/sidebar 写成带透明度的颜色：内联变量优先级高于
    // styles.css 规则，若走 class 规则会被背景自定义的内联值覆盖而失效。
    const translucent = preferences.translucentSidebar;
    const values: Record<string, string> = {
      "--color-background": effective.background,
      "--color-background-alt": effective.backgroundAlt,
      "--color-background-win-alt": effective.backgroundWinAlt,
      "--color-header": effective.header,
      "--color-panel": translucent ? withAlpha(effective.background, 0.74) : effective.panel,
      "--color-sidebar": translucent ? withAlpha(effective.background, 0.74) : effective.sidebar,
      "--color-card": effective.card,
      "--color-popover": effective.popover,
      "--color-input": effective.input,
    };
    for (const [name, value] of Object.entries(values)) {
      root.style.setProperty(name, value);
    }
  } else {
    removeVars(root, BACKGROUND_VARS);
  }

  if (foregroundActive) {
    root.style.setProperty("--color-foreground", effective.foreground);
    root.style.setProperty("--color-foreground-subtle", effective.foregroundSubtle);
    root.style.setProperty("--color-foreground-subtlest", effective.foregroundSubtlest);
  } else {
    removeVars(root, FOREGROUND_VARS);
  }

  if (accentActive) {
    root.style.setProperty("--color-brand", effective.accent);
    root.style.setProperty("--color-primary", effective.accent);
    root.style.setProperty("--color-accent", effective.accentTint);
  } else {
    removeVars(root, ACCENT_VARS);
  }

  applyFontOverrides(root, preferences);
  root.classList.toggle("appearance-translucent-sidebar", preferences.translucentSidebar);
  root.classList.toggle("appearance-pointer-cursor", preferences.pointerCursor);
}

function applyFontOverrides(root: HTMLElement, preferences: AppearancePreferences): void {
  const setOrRemove = (name: string, value: string | null) => {
    if (value) {
      root.style.setProperty(name, value);
    } else {
      root.style.removeProperty(name);
    }
  };
  setOrRemove("--font-sans", preferences.uiFontFamily || null);
  // 内容字体为空 = 与界面字体相同：清除内联，让消费规则回退继承 --font-sans。
  setOrRemove("--font-content", preferences.contentFontFamily || null);
  setOrRemove("--font-mono", preferences.codeFontFamily || null);
  setOrRemove(
    "--appearance-ui-font-weight",
    preferences.uiFontWeight !== 400 ? String(preferences.uiFontWeight) : null,
  );
}

/**
 * 主题切换与外观覆盖的统一入口：先切主题 class，再按新 resolved 主题重算外观内联变量。
 * store 的 setTheme / system 主题变化 / 初始化三处都调用它，保证两步不脱节。
 */
export function applyThemeAndAppearance(theme: Theme, preferences: AppearancePreferences): void {
  applyTheme(theme);
  applyAppearanceToDocument(preferences, resolveTheme(theme));
}
