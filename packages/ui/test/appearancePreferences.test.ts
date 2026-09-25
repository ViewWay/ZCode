import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_THEME_REFERENCE,
  CODEX_THEME_PRESET,
  DEFAULT_APPEARANCE_PREFERENCES,
  applyContrast,
  buildPresetPatch,
  clampContrast,
  computeEffectiveThemeColors,
  getThemePreset,
  loadAppearancePreferences,
  normalizeAppearancePreferences,
  parseAppearanceTheme,
  serializeAppearanceTheme,
  type AppearancePreferences,
} from "../src/lib/appearancePreferences.js";

const CODEX_LIGHT: AppearancePreferences = {
  ...DEFAULT_APPEARANCE_PREFERENCES,
  light: { accent: "#339CFF", background: "#FFFFFF", foreground: "#1A1C1F" },
  lightContrast: 51,
};

test("normalizeAppearancePreferences 校验非法输入并回落默认值", () => {
  const normalized = normalizeAppearancePreferences({
    light: { accent: "339CFF", background: "#GGGGGG", foreground: "#1a1c1f" },
    lightContrast: 250,
    darkContrast: -5,
    uiFontFamily: "Comic Sans MS",
    uiFontWeight: 700,
    translucentSidebar: "yes",
    pointerCursor: 1,
  });
  // 缺 # 前缀与非 hex 视为未自定义；合法 hex 统一大写。
  assert.deepEqual(normalized.light, { accent: null, background: null, foreground: "#1A1C1F" });
  assert.equal(normalized.lightContrast, 100);
  assert.equal(normalized.darkContrast, 0);
  assert.equal(normalized.uiFontFamily, "");
  assert.equal(normalized.uiFontWeight, 400);
  assert.equal(normalized.translucentSidebar, false);
  assert.equal(normalized.pointerCursor, false);
});

test("loadAppearancePreferences 在无 window 环境返回默认值", () => {
  assert.deepEqual(loadAppearancePreferences(), DEFAULT_APPEARANCE_PREFERENCES);
});

test("getThemePreset 区分 default / codex / custom", () => {
  assert.equal(getThemePreset(DEFAULT_APPEARANCE_PREFERENCES.light), "default");
  assert.equal(getThemePreset(CODEX_THEME_PRESET.light), "codex");
  assert.equal(getThemePreset(CODEX_THEME_PRESET.dark), "codex");
  assert.equal(getThemePreset({ accent: null, background: "#FFFFFF", foreground: null }), "custom");
});

test("buildPresetPatch：default 清空自定义，codex 返回截图同款值", () => {
  const cleared = buildPresetPatch("light", "default");
  assert.deepEqual(cleared, {
    colors: { accent: null, background: null, foreground: null },
    contrast: 50,
  });
  const codex = buildPresetPatch("dark", "codex");
  assert.deepEqual(codex.colors, {
    accent: "#0169CC",
    background: "#111111",
    foreground: "#FCFCFC",
  });
  assert.equal(codex.contrast, 60);
});

test("applyContrast：50 不改动；超范围收敛；>50 向纯端点靠拢；<50 拉近前景背景", () => {
  const colors = { background: "#808080", foreground: "#404040" };
  assert.deepEqual(applyContrast("light", colors, 50), colors);
  assert.deepEqual(applyContrast("light", colors, 250), applyContrast("light", colors, 100));

  const stronger = applyContrast("light", colors, 100);
  // 浅色模式拉高对比：背景变亮、前景变深；上限为向端点混合 50%，保留用户所选底色。
  assert.equal(stronger.background, "#C0C0C0");
  assert.equal(stronger.foreground, "#202020");

  const weaker = applyContrast("light", colors, 0);
  const distanceBefore = Math.abs(0x80 - 0x40);
  const distanceAfter = Math.abs(
    parseInt(weaker.background.slice(1, 3), 16) - parseInt(weaker.foreground.slice(1, 3), 16),
  );
  assert.ok(distanceAfter < distanceBefore);
});

test("computeEffectiveThemeColors：null 回落内置参照，自定义与对比度生效", () => {
  const fallback = computeEffectiveThemeColors(DEFAULT_APPEARANCE_PREFERENCES, "light");
  assert.equal(fallback.background, BUILTIN_THEME_REFERENCE.light.background);
  assert.equal(fallback.accent, BUILTIN_THEME_REFERENCE.light.accent);

  // Codex 预设 + 对比度 51：浅色背景向白混合后仍是白色。
  const codexLight = computeEffectiveThemeColors(CODEX_LIGHT, "light");
  assert.equal(codexLight.accent, "#339CFF");
  assert.equal(codexLight.background, "#FFFFFF");

  // 深浅模式互不泄漏。
  const lightOnly: AppearancePreferences = {
    ...DEFAULT_APPEARANCE_PREFERENCES,
    light: { accent: null, background: "#FFFFFF", foreground: null },
  };
  const mixed = computeEffectiveThemeColors(lightOnly, "dark");
  assert.equal(mixed.background, BUILTIN_THEME_REFERENCE.dark.background);
  assert.equal(computeEffectiveThemeColors(lightOnly, "light").background, "#FFFFFF");
});

test("serialize/parse 主题 JSON 往返一致并拒绝非法输入", () => {
  const json = serializeAppearanceTheme("light", CODEX_LIGHT);
  const parsed = parseAppearanceTheme(json);
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.equal(parsed.mode, "light");
    assert.deepEqual(parsed.colors, CODEX_LIGHT.light);
    assert.equal(parsed.contrast, 51);
  }

  const invalidCases = [
    "not json",
    JSON.stringify({ version: 2, mode: "light", colors: CODEX_THEME_PRESET.light }),
    JSON.stringify({ version: 1, mode: "sepia", colors: CODEX_THEME_PRESET.light }),
    JSON.stringify({ version: 1, mode: "light", colors: { accent: "blue", background: "#FFF" } }),
    JSON.stringify({
      version: 1,
      mode: "light",
      colors: { accent: null, background: null, foreground: null },
    }),
  ];
  for (const text of invalidCases) {
    assert.equal(parseAppearanceTheme(text).ok, false, text);
  }
});

test("clampContrast 将非法输入收敛到默认值/边界", () => {
  assert.equal(clampContrast(undefined), 50);
  assert.equal(clampContrast(Number.NaN), 50);
  assert.equal(clampContrast(51.4), 51);
  assert.equal(clampContrast(101), 100);
});
