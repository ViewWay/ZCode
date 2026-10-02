# Spec：会话互聊转正（session-chat promotion）

`apps/zcode-cli/packages/core/src/tool/handlers/session-chat.ts` 已实现 SessionList /
SessionTalk / SessionCreate（实验性，头注明确"specs 对齐 MiMo 实验室同名功能"）。本
spec 把它从实验转正，并补齐与 MiMo `talk_to_session` / `contacts` 的成熟度差距。

## 目标

1. SessionList 输出补齐：会话标题 + busy/idle 状态（当前只有存活列表）。
2. 桌面形态默认注入 SessionChatPort（当前为实验开关）；CLI/TUI 维持关闭或显式开启。
3. 保持与 agent-teams 的边界：不读写 TeamFile/mailbox，双向独立。

## 现状与增量

| 项 | 现状 | 增量 |
| --- | --- | --- |
| 工具面 | core 已实现三个工具（contracts 已有 Schema） | SessionList 输出扩展 `status`（busy/idle）与 `title` 字段 |
| 宿主端口 | 实验开关开启时注入 SessionChatPort，端口缺席即不注册工具（fail-closed） | desktop 默认注入；CLI/TUI 保持现状（**待定项**） |
| 状态 | 无 busy/idle | 会话状态从宿主会话注册表读取：busy = 目标会话存在未完成 turn |

## 领域词汇

- **存活会话**：本 workspace 内进程存活、可接收投递的会话。
- **busy**：目标会话有未完成 turn；**idle**：无未完成 turn 且存活。
- **投递**：SessionTalk 的 fire-and-return 语义——消息进目标会话 admission 队列，
  回应由接收方模型调用 SessionTalk 发回。

## 状态所有者与数据流

```text
宿主（协议 server）持有会话注册表 → SessionChatPort
  → SessionList handler 读注册表（状态+标题）
  → SessionTalk handler → 目标会话 admission 队列（既有投递路径不变）
```

- 状态与标题的唯一所有者是宿主会话注册表；工具不缓存，不建第二状态源。

## 边界与安全

- 保持 fail-closed：端口缺席 → 工具不注册（维持现有行为，不降级为报错）。
- 投递只进 admission，不中断目标会话当前 turn；无打断语义。
- 与 agent-teams 双向独立（沿用 session-chat.ts 头注的边界声明）。

## 非目标（v1 边界）

- 不做跨 workspace / 跨设备互聊。
- 不做打断目标会话的硬中断。
- 不做消息已读/未读回执。

## 验收场景

1. 同 workspace 双会话：A 列出 B（显示 idle + 标题）→ SessionTalk 投递 → B 的下轮
   admission 收到并回应。
2. B 正在跑任务（busy）时投递不打断，B 完成后处理消息。
3. CLI 直跑（无宿主端口）时三个工具不注册，无残留错误。

## 验证

- handler 测试用内存 SessionChatPort；断言 busy/idle 推导与投递顺序。
- E2E 双会话互发场景。
- `pnpm typecheck`；`pnpm architecture:check --changed`。
