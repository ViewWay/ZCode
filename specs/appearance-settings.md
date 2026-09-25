# Spec：外观设置（Codex 式主题自定义）

## 目标

1. 设置页「外观」分区重构为 Codex 风格：顶部外观预览、「浅色主题」/「深色主题」两张自定义卡（强调色 / 背景 / 前景 / UI 字体 / 内容字体 / 代码字体 / 半透明侧边栏 / 对比度），底部「偏好设置」（使用指针光标）。
2. 每张主题卡支持：主题预设下拉（默认 / Codex / 自定义）、复制主题、导入主题；颜色改动真实生效（覆盖对应主题的 CSS 变量）。
3. 字体、半透明侧边栏、指针光标为全局共享设置；颜色与对比度按浅色/深色分别存储。

## 非目标（v1 边界）

- 不内置多套完整配色预设（仅「默认 = 跟随内置主题」与「Codex」两档）。
- 不做主题市场/文件导入；导入仅支持粘贴 JSON 文本。
- 代码预览设置（shiki 主题、行号、折行、代码字号）保留原状，仅移动到外观分区后半部分。
- 不覆盖终端字体（`AppSettings.terminalFontFamily` 独立管理）。

## 状态所有者

```text
appearancePreferences（zustand store，唯一所有者；切片工厂在 store/appearancePreferencesState.ts）
  ├─ localStorage: zcode-appearance-preferences（持久化）
  ├─ BroadcastService "state:appearancePreferences"（跨窗口同步）
  └─ applyThemeAndAppearance(prefs, theme) → applyTheme + applyAppearanceToDocument
     （documentElement 内联 CSS 变量 + html class，见 lib/appearanceThemeApply.ts）
内置主题默认值（styles.css .theme-zai-light / .theme-zai-dark，只读参照）
```

- 写路径唯一：组件只调用 `setAppearancePreferences(patch)`；setter 内完成 normalize → localStorage → `applyAppearanceToDocument` → set。广播接收端复用同一 setter（`applyingBroadcast` 防回环，沿用既有机制）。
- `setTheme`、system 主题变化监听、store 初始化三处都会在 `applyTheme` 之后重新调用 `applyAppearanceToDocument`，保证内联变量始终匹配当前 resolved 主题（浅色/深色各自取值，互不泄漏）。

## 数据模型

```ts
interface ThemeAppearanceColors {
  accent: string | null;      // null = 跟随内置主题
  background: string | null;
  foreground: string | null;
}
interface AppearancePreferences {
  light: ThemeAppearanceColors;
  dark: ThemeAppearanceColors;
  lightContrast: number;      // 0–100，默认 50
  darkContrast: number;
  uiFontFamily: string;       // "" = 系统默认
  uiFontWeight: 400 | 500 | 600;
  contentFontFamily: string;  // "" = 与界面字体相同
  contentFontWeight: 400 | 500 | 600;
  codeFontFamily: string;     // "" = 系统默认（--font-mono 内置栈）
  codeFontWeight: 400 | 500 | 600;
  translucentSidebar: boolean;
  pointerCursor: boolean;
}
```

- 颜色仅接受 `#RRGGBB`（normalize 阶段把非法值回落为 null，不抛错）。
- 预设判定是纯函数：三色全为 null → `default`；与 Codex 预设值一致 → `codex`；否则 `custom`。选择预设即写入对应颜色（Codex 预设同时写对比度 51/60，与截图一致）；手动改色后下拉自动显示 `custom`。
- 字体选项是固定枚举栈（跨平台回退），非自由输入。

## 颜色生效规则（computeEffectiveThemeColors）

1. 自定义色为 null 时回落到该主题的内置参照值（与 styles.css 中 zai 主题一致：浅色 bg `#f8f8f8` / fg `#1f1f1f` / accent 用 brand `#0b7fff`；深色 bg `#161616` / fg `#f2f2f2` / accent `#38bdf8`）。
2. 对比度：`t = (contrast − 50) / 50 ∈ [−1, 1]`。`t > 0` 时背景/前景各自向纯端点（浅色 `#FFFFFF`/`#000000`，深色 `#000000`/`#FFFFFF`）混合 `t × 0.5`；`t < 0` 时背景与前景互相靠近 `−t × 0.25`。默认 50 = 完全使用所选颜色。
3. 派生 token（在 documentElement 内联设置，优先级高于主题 class）：
   - `--color-background` ← 背景有效值；`--color-background-win-alt` ← 向黑(浅)/白(深)混 4%/12%；`--color-background-alt` ← 同有效背景 70% 透明混合。
   - `--color-header`/`--color-panel`/`--color-sidebar`：浅色 = 有效背景（侧边栏 #f0f0f0 例外由 token 消费侧近似，不单列）；深色 = 向白混 5.5%。
   - `--color-card`/`--color-popover`/`--color-input`：浅色 = 内置卡面比背景更亮，取向白混 50%；深色 = 向白混 12%。
   - `--color-foreground` ← 前景有效值；`--color-foreground-subtle(-st)` 用内置公式（60%/40% 混透明）重算。
   - `--color-brand`、`--color-primary` ← 强调色有效值；`--color-accent` ← 强调色向透明混合（浅色 12%、深色 20%）。
4. 自定义为 null 的颜色组不写入内联（移除内联值），完全交还内置主题；仅对比度偏离 50 时背景/前景组仍生效。

## UI 行为

- 外观预览：置于分区顶部，按当前 resolved 主题渲染样例；`Aa` 按钮切换代码样例 ↔ 文字样例；背景/前景/代码字体取该主题有效值实时更新。
- 主题卡头：标题 + 「导入」「复制主题」按钮 + 预设下拉。
  - 复制主题：`{ version: 1, mode, colors, contrast }` JSON 写剪贴板；失败时 logger.warn，UI 无崩溃。
  - 导入：Dialog + textarea 粘贴 JSON，「应用」校验通过后写入该模式；非法 JSON/字段在行内显示错误，不改动当前值。
- 强调色行：来源下拉（默认 / 自定义）+ 色板（`input[type=color]`）+ hex 输入；来源为「默认」时输入禁用。背景/前景行：色板 + hex 输入，自定义后出现「恢复默认」小按钮。
- 对比度：原生 range 滑杆（accent-color 用 brand token），右侧显示数值。
- 偏好设置卡：使用指针光标 Switch；界面字号沿用既有行。
- 浅色/深色卡中的字体行与「半透明侧边栏」绑定同一份共享状态（两卡仅是两个视图，不存在两份状态）。

## CSS 生效点（styles.css）

- 半透明侧边栏：`--color-panel`/`--color-sidebar` 的 74% 背景透明混合由 `applyAppearanceToDocument` 直接写内联变量（内联优先级高于 class 规则，避免被背景自定义覆盖失效）；`.appearance-translucent-sidebar [data-appearance-translucent]`（工作区左栏 aside，WorkspaceShellLayout）加 backdrop-blur。
- `.appearance-pointer-cursor`：`button`、`[role="button"]`、`select`、`a` 显式 `cursor: pointer`。
- 字体：html 内联 `--font-sans`（UI，随 Tailwind preflight 生效）、`--font-content`（内容字体，经 `message.tsx` responseClassName 上的 `.appearance-content-font` 规则作用于助手 markdown）、`--font-mono`（代码）；`body { font-weight: var(--appearance-ui-font-weight, 400) }` 为 UI 字重基线。

## 失败语义

- localStorage 解析失败 → 整体回落 `DEFAULT_APPEARANCE_PREFERENCES`（与既有 codePreviewSettings 一致）。
- 导入 JSON 校验失败 → 行内错误，不改状态。
- 剪贴板写入失败 → logger.warn，UI 无崩溃。

## 验收场景

1. 选择 Codex 预设（浅色卡）：强调色 #339CFF、背景 #FFFFFF、前景 #1A1C1F、对比度 51，应用界面立即变为蓝强调 + 白底。
2. 切换深色模式后：深色卡改动独立生效，浅色改动不泄漏（`applyAppearanceToDocument` 按 resolved 主题重算）。
3. 复制主题 → 导入粘贴同 JSON → 值完全一致；粘贴非法 JSON 显示错误且不改动。
4. 半透明侧边栏关闭后恢复完全不透明；刷新页面后所有设置保持（localStorage）。
5. 第二个窗口（广播）同步相同外观设置。
