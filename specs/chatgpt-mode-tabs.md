# Spec：草稿首页模式标签页（chatgpt-mode-tabs）

## 目标

对齐 ChatGPT 的"ChatGPT ↔ Codex 标签页切换 + 两种模式推荐 UI 统一"：草稿首页顶部提供
`对话 | 任务` 分段标签，两种模式共用同一 composer、同一推荐 chips 实例（统一性由同一
挂载实例保证），仅问候语与 composer 占位文案随模式切换。

## 产品规则

- 标签页只出现在**草稿首页**（会话内不显示，与 ChatGPT 一致）。
- 默认模式 `chat`（对话）；模式状态为内存态，不持久化（记忆上次模式列二期）。
- 两种模式**不重挂载** composer 与推荐 chips——切换只换问候语和占位文案，草稿与
  焦点不丢。
- 分段控件为有意胶囊造型（ChatGPT 同款 segmented pill），符合 DESIGN.md 的
  rounded-full 例外；选中段 `bg-card` 浮起，未选中 `text-foreground-subtle`。

## 状态所有者与数据流

```text
SessionPane（草稿分支）
  └─ draftHomeMode: "chat" | "tasks"（useState，内存）
       ├─ ConversationDraftModeTabs（tablist，受控）
       ├─ ConversationDraftEmptyState titleMessageId={tasks 时覆盖问候}
       └─ ConversationComposer homeMode={draftHomeMode} → resolveChatPlaceholder
```

唯一所有者是 SessionPane 的 draftHomeMode；不写 settings、不进 store，无第二条写入路径。

## 范围

**改**：

| 文件 | 改动 |
| --- | --- |
| `v4/ConversationDraftModeTabs.tsx`（新） | tablist 分段控件（对话/任务） |
| `v4/SessionPane.tsx` | draftHomeMode 状态；emptyState 顶部渲染 tabs；composer 传 homeMode |
| `v4/ConversationDraftEmptyState.tsx` | 可选 `titleMessageId` 覆盖时段问候 |
| `v4/ConversationComposer.tsx` | 可选 `homeMode` prop；placeholder 解析带模式 |
| `lib/chatPlaceholder.ts` | 新键 `chat.placeholder.tasksHome` + 可选 `tasksHomeMode` 参数 |
| i18n zh-CN / en-US | `chat.draft.mode.chat/tasks`、`chat.tasks.greeting`、`chat.placeholder.tasksHome` |

**不改**：推荐 chips 数据源（远端 scene + feature prompts）、composer/chips 挂载结构、
侧边栏、会话内 UI。"最近任务"列表（Codex 首页形态）需接 sidebar 的 session store，
列 `specs/chatgpt-parity-roadmap.md` 二期。

## 验收场景

1. 草稿首页显示 `对话 | 任务` 分段控件，默认选中"对话"，时段问候照常。
2. 切"任务"：问候变为固定文案，占位文案变为任务式；composer/chips 不重挂载（输入中
   草稿不丢、焦点不跳）。
3. 切"对话"：时段问候恢复。
4. 窄容器/手机 Web：分段控件与问候同列居中，不溢出。
5. 明暗主题（含 Zai）：选中/未选中段对比度可读。

## 验证

- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
- 实机走查（dev:web 5173）：核对两模式问候/占位/推荐 chips 一致性；切换时 composer
  焦点不丢。
