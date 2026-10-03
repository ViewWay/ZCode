# Spec：主聊天面 ChatGPT 风格化（chatgpt-style-chat-surface）

## 目标

把主聊天面（会话时间线 + composer）的视觉语言对齐 ChatGPT：统一居中窄内容列、
右对齐无边框灰底大圆角用户气泡、大圆角轻投影输入壳。功能、状态与数据流不变，
只动展示层的宽度与样式类。

## 范围

**改**：

| 表面 | 文件 | 规则 |
| --- | --- | --- |
| 会话内容列宽度（唯一所有者） | `packages/ui/src/v4/conversationLayout.ts` | 草稿列与会话列统一 `max-w-3xl`（48rem = 768px）；`@min-[864px]`/`@min-[1280px]` 的让位 calc 与状态面板偏移语义保留 |
| 用户消息气泡 | `packages/ui/src/v4/ConversationRowView.tsx` | `rounded-3xl bg-secondary` 无边框，`px-5 py-2.5`；≥624px 容器仍以 `max-w-xl`（≈列宽 75%）封顶并右对齐 |
| 分享只读时间线气泡 | `packages/ui/src/v4/ConversationShareReadonlyTimeline.tsx` | 与主时间线用户气泡保持同一类组合 |
| 输入壳 | `packages/ui/src/prompt-editor/ChatPromptEditor.tsx` | shell 与拖拽遮罩 `rounded-3xl`，附加 `shadow-sm`；边框继续走 input 语义 token |
| 草稿态输入卡 | `packages/ui/src/v4/ConversationComposer.tsx` | contextHeader 输入卡圆角对齐 shell（`rounded-3xl`） |
| 设计规范 | `DESIGN.md` | 圆角例外清单同步：用户气泡与主输入壳允许 `rounded-3xl` |

**不改**：

- 语义色 token 嬗值（Zai Light / Zai Dark 维持现状，气泡填充用既有 `bg-secondary`）。
- `ai-elements/message.tsx` 通用库面（share/side pane 等其他消费方后续再对齐）。
- `WorkspaceSidebar`、状态面板、queue、workflow 图等操作面。
- 消息间距（`pt-14`）、空状态问候布局、手机远控的单列结构。

## 状态所有者与数据流

无状态变化。宽度仍由 `getConversationContentWidthClassName` 单点下发，
消息列与 composer dock 共用同一 class（`ConversationTimeline.tsx` 消费），
不新增第二条宽度路径。

## 验收场景

1. 草稿态：问候语 + composer 居中，列宽 48rem；输入壳大圆角带轻投影。
2. 会话态（≤1280px 容器）：消息列与 composer 同宽居中；用户消息为右对齐灰底大圆角气泡，无边框。
3. 会话态（≥1280px 容器 + inline 状态面板）：内容列与 dock 同步左移让位，面板不遮正文。
4. 手机 Web / 窄容器：列回退 `w-full`，气泡 `max-w-full` 右对齐，不溢出。
5. 明暗主题（含 Zai 双主题）：气泡 `bg-secondary`、输入壳 `bg-input` 在四套主题下对比度可读。
6. 分享只读时间线：用户气泡与主时间线观感一致。

## 验证

- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
- `packages/ui` 无组件测试基建（package.json 仅 lint 脚本），视觉回归依赖
  上述静态检查 + 人工/E2E 走查；本轮如实说明未跑浏览器验证。
