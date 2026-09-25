# Spec：Command Center 搜索弹窗布局（ChatGPT 式居中卡片）

## 背景

用户要求把 Command Center 搜索弹窗改成 ChatGPT 搜索的布局样式（参考截图）：垂直居中的浮动卡片、顶部搜索输入行、右上角关闭按钮、「最近聊天」式的最近会话列表作为默认主内容。当前实现为顶部锚定（`top-16/sm:top-20`）、窄卡（`max-w-lg`），默认视图以「最近变更」开头。

## 目标

仅调整 Command Center 弹窗的**布局与默认视图顺序**，不改变任何搜索能力。

## 非目标

- 不改动搜索数据源与能力：scope 前缀（`>` `#` `@`）、scope tabs（全部/操作/任务/文件）、命令/任务/文件三类结果、搜索历史 chips 全部保留。
- 不改动状态所有者：开合状态仍由 App 层 `isQuickPickOpen` 持有；搜索历史仍由 `commandCenterSearchHistory` 持有；任务列表仍经 `useGlobalTaskList` 读取。
- 不新增新的弹窗组件，仍在 `CommandCenterDialog` + `CommandDialog`（Radix Dialog + cmdk）内改造。

## 行为

1. **居中弹窗**：弹窗改为垂直水平居中（继承 `quickPickDialogClassName` 的 `top-1/2 -translate-y-1/2`），宽度加宽至 `max-w-2xl`。全平台（含 Linux desktop）使用同一居中定位：`dialog.tsx` 的旧 Linux 标题栏避让已移除，不再需要原顶部锚定布局的 Linux top 补偿。
2. **顶部输入行**：搜索图标 + 无边框输入 + 行尾关闭按钮（`aria-label = commandCenter.close`）；关闭按钮与 ESC 均可关闭弹窗。
3. **scope tabs**：保留在输入行下方一行，样式不变。
4. **默认视图分区顺序**（无查询、scope=全部）：最近任务 → 最近变更 → 快捷入口。最近会话列在首位，对齐参考稿中「最近聊天」的主位。
5. **最近任务预览条数**：默认视图展示 6 条（`COMMAND_CENTER_RECENT_TASK_PREVIEW_LIMIT`），取数上限同步放宽；最近变更预览维持 3 条。
6. **有查询时**：结果分区顺序不变（命令 → 任务 → 文件）。

## 状态所有者

无新增状态。布局相关常量（默认分区顺序、最近任务预览上限）提取到纯模块 `command-center/commandCenterSections.ts`，由 `CommandCenterDialog` 消费、单测覆盖。

## 验收场景

1. ⌘K / 侧边栏搜索入口打开 → 弹窗垂直居中出现；ESC 或点击输入行右侧 ✕ → 关闭。
2. 无查询 → 「最近任务」位于结果区首位，最多 6 条，每条带会话图标与相对时间。
3. 输入查询 → 分区顺序与 scope 行为与改造前一致；`>` `#` `@` 前缀快捷切换仍生效。
4. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、`pnpm exec tsx --test packages/ui/test/commandCenterSections.test.ts` 通过。
