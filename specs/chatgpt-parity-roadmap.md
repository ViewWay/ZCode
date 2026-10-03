# Spec：ChatGPT 对齐评估与路线图（chatgpt-parity-roadmap）

## 背景

用户要求将 ZCode 的 UI 与功能同 ChatGPT 对齐。2026-10-03 用 `pnpm dev:web`（5173 端口，暗色主题，1440×900）实机走查了草稿态、真实会话、侧边栏与消息渲染后得出以下结论。聊天面视觉骨架已在 `specs/chatgpt-style-chat-surface.md` 落地（统一 48rem 居中列、无边框灰底大圆角用户气泡、大圆角轻投影输入壳）。

**定位边界**：ZCode 是 agent 工作台，不是 ChatGPT 克隆。工具块、Git 集成、状态面板、多会话、团队/自动化/插件市场是超出 ChatGPT 的能力，不做减法式对齐；对齐目标是"对话体验层"。

## 实机核查结论

**已对齐或已有对应物**（无需再动）：

- 暗色近黑主题、居中问候 + 居中 composer 的空态、底部账号区
- 768px 居中内容列、右对齐灰底大圆角用户气泡、全宽纯文本助手消息
- 会话行 hover 置顶/归档、侧边栏折叠 rail、⌘K 搜索、归档入口
- 分组模式含 今天/昨天/本周/更早 日期分组基建（`lib/taskTimelineGroups.ts`）
- 建议 chips、模型/思考档位选择、Smart 路由、变更前确认/完全访问模式
- 消息级 复制/赞/踩/分叉/编辑、思考折叠、工具详情、问题导航轨、回到底部
- 分享、停止、@ 提及 / / 命令、附件与上下文引用

**真缺口**（ChatGPT 有、ZCode 无）：

| # | 缺口 | 现状与依赖 |
| --- | --- | --- |
| 1 | 编辑消息后的版本切换（ChatGPT 的 ‹ 1/2 › 浏览） | `MessageBranch*` 原语已在 `ai-elements/message.tsx`，v4 未接线；需 host 会话协议支持多版本存储；ZCode 的编辑已带 workspace rewind，语义需先对齐再设计 |
| 2 | 语音输入 / 语音对话 | `specs/voice-pipeline.md` 在案，语音/图像端点与 UI 接线是缺口 |
| 3 | 消息朗读（read aloud） | 依赖 TTS 端点，随语音管线一并落地 |
| 4 | 临时会话（不计历史、不进侧边栏持久化） | 需会话存储与生命周期设计 |
| 5 | 跨会话记忆（memory） | 需存储层与策略设计，涉及隐私边界 |

## P1 功能对齐（每项开工前先按 AGENTS.md 补独立 spec）

1. **编辑版本切换**：host 侧为用户消息维护多版本（已有 checkpoint/rewind 基建可挂靠）；UI 接线 `MessageBranch*`，气泡下方出 ‹ 1/2 › 导航；验收 = 编辑后可往返浏览旧版本并重发。
2. **语音模式**：按 `specs/voice-pipeline.md` 补端点接线与 composer 语音按钮/实时面板；手机 Web 复用同组件。
3. **消息朗读**：TTS 端点 + 消息操作区朗读按钮；流式期间禁用。
4. **临时会话**：会话创建参数 + 侧边栏不持久化 + 标题栏"临时"标识；关闭即弃。
5. **记忆**：独立 spec 决策存储位置（workspace 级/全局级）、注入时机、开关与清除入口。

## P2 体验打磨（UI 层小项）

1. **额度提醒 toast 锚点**：实机观察到草稿态 quota toast（"4 次重置额度"）与居中 composer 视觉冲突（压在输入壳上缘）。改锚点或错峰出现，避免遮挡输入区。
2. **会话标题溢出**：现为 hover 走马灯（有意设计，已含 reduced-motion 处理）；ChatGPT 用省略号截断。是否替换属产品决策，默认保留现状。

## 不做（边界声明）

- 不用 ChatGPT 配色替换 Zai 主题语义 token（气泡/输入壳已用语义 token 达到同款观感）。
- 不裁剪工具块/Git/状态面板/团队/自动化/插件市场等操作面。
- 不复刻 GPTs 商店/深度研究/图片生成等纯消费形态（插件市场承担该生态位）。

## 验证

- P1 各项按 AGENTS.md 先 spec 后代码，测试与 E2E 场景随各自 spec 定义。
- P2 项改后跑 `pnpm typecheck` + `pnpm lint` + `pnpm architecture:check --changed`，并实机复核草稿态与会话态。
