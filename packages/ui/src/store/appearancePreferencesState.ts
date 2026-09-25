/**
 * 外观偏好 store 切片：唯一写入口。
 * setter 内完成 normalize → localStorage → applyAppearanceToDocument，
 * 广播接收端与设置页复用同一 setter（防回环沿用 store 的 applyingBroadcast 机制）。
 */
import { writeSafeLocalStorage } from "@/lib/browserEnvironment.js";
import {
  APPEARANCE_PREFERENCES_STORAGE_KEY,
  loadAppearancePreferences,
  normalizeAppearancePreferences,
  type AppearancePreferences,
} from "@/lib/appearancePreferences.js";
import { applyAppearanceToDocument } from "@/lib/appearanceThemeApply.js";
import { resolveTheme, type Theme } from "@/useTheme.js";

export interface AppearancePreferencesState {
  appearancePreferences: AppearancePreferences;
  setAppearancePreferences: (patch: Partial<AppearancePreferences>) => void;
}

export function createAppearancePreferencesState({
  readState,
  writeState,
}: {
  readState: () => { appearancePreferences: AppearancePreferences; theme: Theme };
  writeState: (
    updater: (state: { appearancePreferences: AppearancePreferences }) => {
      appearancePreferences: AppearancePreferences;
    },
  ) => void;
}): AppearancePreferencesState {
  return {
    appearancePreferences: loadAppearancePreferences(),
    setAppearancePreferences: (patch) =>
      writeState((state) => {
        const next = normalizeAppearancePreferences({ ...state.appearancePreferences, ...patch });
        writeSafeLocalStorage(APPEARANCE_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
        // 外观内联变量的取值依赖当前 resolved 主题，这里同步重算，避免主题切换后残留。
        applyAppearanceToDocument(next, resolveTheme(readState().theme));
        return { appearancePreferences: next };
      }),
  };
}
