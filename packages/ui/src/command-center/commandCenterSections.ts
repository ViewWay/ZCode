/**
 * Command Center 默认视图（无查询时）的分区顺序与「最近任务」预览上限。
 *
 * 布局规则（specs/command-center-search-layout.md）：最近任务列在首位
 * （对齐 ChatGPT 搜索的「最近聊天」主位），其次最近变更、快捷入口。
 * 提取为无 JSX 的纯模块，便于 node:test 直接加载单测。
 */
export const COMMAND_CENTER_DEFAULT_SECTION_ORDER = [
  "recentTasks",
  "recentChanges",
  "commands",
] as const;

export type CommandCenterDefaultSectionId = (typeof COMMAND_CENTER_DEFAULT_SECTION_ORDER)[number];

/** 默认视图下「最近任务」的预览条数（ChatGPT 式最近列表密度）。 */
export const COMMAND_CENTER_RECENT_TASK_PREVIEW_LIMIT = 6;
