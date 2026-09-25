# Spec：Agent Teams（多代理团队协作）

## 目标

在 ZCode 中支持 Claude Code 语义的 **Agent Teams**：lead agent 创建命名团队、派出**常驻命名 teammate**（区别于一次性 subagent），teammate 之间通过邮箱式消息协作、共享团队任务列表，权限请求带 teammate 来源标识，UI 提供 team roster 视图。

## 现状与增量

Runtime（`apps/zcode-cli/packages/core`）已具备的底座，本 spec **只复用、不重建**：

| 既有模块 | 作用 |
| --- | --- |
| `subagent/runner.ts` + `runtime-task-registry.ts` | 子代理执行与任务注册（后台/前台） |
| `subagent/message-steering.ts` + `runtime/methods/turn-loop-state.ts`（SendMessage） | 向运行中的子代理注入消息、turn 循环处理传入消息 |
| `subagent/completion-notification.ts` | 完成通知注入主代理 |
| `subagent/interaction-origin.ts` + `subagent/tool-policy.ts` | 权限来源标记、工具池过滤 |
| `subagent/explore.ts` / `general-purpose.ts` / `profile*.ts` | 内置 agent 与 profile 定义 |
| `memory/` | 记忆提取与召回（与 teams 正交，不改） |

**v1 增量**（当前全部缺失，`team_name`/`TeamCreate`/`teammate` 在仓库内零命中）：

1. 命名 teammate 生成路径（常驻、可空闲待命、不随单任务结束退出）。
2. 团队注册表（TeamFile）：磁盘事实源，记录团队与成员。
3. teammate 间邮箱消息（peer-to-peer + 广播），与既有 parent→child steering 并存。
4. 共享任务列表工具组（TaskCreate/TaskUpdate/TaskGet/TaskList）。
5. 团队级权限路径与 UI roster 视图。

## 领域词汇

- **Lead**：创建团队的会话（主 agent），团队唯一协调者。
- **Teammate**：具名常驻代理，由 `Agent({ team_name, name })` 生成，有自己的消息循环，空闲时待命不退出。
- **TeamFile**：团队注册表 JSON（磁盘事实源）。
- **Mailbox**：teammate 收件箱队列（按成员命名的 JSON 文件，文件锁互斥写入）。
- **共享任务列表**：团队内所有成员可读写的任务集合；与个人 `TodoWrite`（会话私有）严格区分。

## 非目标（v1 边界）

- 不做跨设备 / 分布式团队；团队随 lead 会话生命周期，会话结束即清理（见「清理」）。
- 不做 teammate 跨会话复活 / 持久化对话历史回放。
- 不做 tmux / iTerm2 执行后端；仅 in-process（ZCode 为 GUI 产品，UI bridge 始终可用）。
- 不做 UDS / bridge 远程 teammate 寻址（`bridge:`/`uds:` 前缀）。
- 不做 teammate 数量配额之外的超卖保护（v1 上限：每团队 8 个 teammate，超出报错）。

## 一、团队与成员生命周期（runtime）

### 行为

- 新增工具 `TeamCreate({ name, description? })`：lead 调用，创建 TeamFile 并注册 lead 为首成员；同名团队存在时幂等返回既有团队。
- `Agent` 工具新增路由：入参同时含 `team_name` 与 `name` 时走 teammate 生成路径（沿用 `spawnTeammate` 语义），否则维持现状（subagent / 后台 / 同步）。
- teammate 拥有独立 abort 生命周期：**不随 lead 单轮中断而取消**，仅随 lead 会话终止 / TeamDelete / shutdown 审批通过而终止。
- 成员状态 `isActive: boolean`：执行 turn 中为 true，空闲待命为 false；状态变化以事件广播给 UI（roster 用）。
- 新增工具 `TeamDelete({ name })`：向全部存活 teammate 发 shutdown_request，等待审批结果（有 UI bridge 时弹确认，超时 30s 视为拒绝并强制终止），随后删除 TeamFile 与 mailbox。

### 存储约定（磁盘为唯一事实源）

- 目录：`<home>/.zcode/teams/<workspace-key>/<team-name>/`；`workspace-key` 复用 workspaceIdentity 归一规则（`workspaceIdentity?.trim() || workspacePath`），与 AGENTS.md 一致，不在业务代码手写格式。
- `config.json`（TeamFile）：`{ name, description?, createdAt, leadAgentId, leadSessionId?, members: [{ agentId, name, color?, permissionMode?, cwd, sessionId?, isActive, joinedAt }] }`；`color` 复用 `packages/services/src/subagents/subagentMarkdown.ts` 的 8 色板。
- `inboxes/<member-name>.json`：消息数组（见下节）；写入使用文件锁（重试 + 指数退避），保证多写者互斥。
- services 层（`packages/services`）只提供**只读发现/解析**（供 UI roster 与设置页展示），不新增第二条写入路径——写所有权归 runtime。

### 状态所有者与事件顺序

```text
TeamFile / mailbox（磁盘，事实源，runtime 唯一写入者）
   ↑ TeamCreate / spawnTeammate / SendMessage / TeamDelete
Runtime（teammate 会话循环、isActive、审批等待）：唯一业务状态所有者
   ↓ 协议事件（team_member_changed / inbox_message / interaction_request）
UI roster（packages/ui）：纯视图 + 发起交互，不缓存成员真相，刷新即重读
```

spawn 顺序：`TeamCreate → Agent({team_name,name}) → 写 TeamFile members → 发 task_started 事件 → roster 收到成员变更`。重复 spawn 同名 teammate：报错（幂等保护），不覆盖。

## 二、消息与邮箱（runtime）

### 路由规则（`SendMessage({ to, message })` 扩展）

```text
to === "*"            → 广播：遍历 TeamFile 全部成员逐一投递（发送者除外）
to ∈ TeamFile.members → 写 inboxes/<to>.json（文件锁互斥）
to = 当前 in-process 子代理（既有 agentNameRegistry）→ 维持既有 steering 路径，不变
其余                  → 维持现状报错，不新增前缀寻址
```

### 消息类型

| 类型 | 载荷 | 处理 |
| --- | --- | --- |
| 纯文本 | `string` | 注入为 teammate 新对话轮（复用 turn-loop 传入消息通道） |
| `shutdown_request` | `{ type, reason }` | teammate 弹 UI 确认；approve → 优雅退出并从 roster 移除；reject → 回执拒绝，继续运行 |
| `plan_approval_request/response` | `{ type, request_id, approve }` | teammate 计划审批走 lead/用户确认，结果按 request_id 配对回执 |
| `idle_notification` | — | teammate 空闲时通知 lead（防 lead 盲等） |

投递语义：至多一次 + 确认读（read 标志）；轮询间隔 1s；广播对每个成员独立落盘，单成员失败不阻断其他成员。

### 时序（消息 + 关停）

```text
TeammateA                TeamFile/mailbox              TeammateB
   │ SendMessage(to=B)        │                            │
   │─────────写锁写入────────▶│                            │
   │                          │────1s 轮询读未读──────────▶│
   │                          │                            │ 注入新 turn
   │                          │◀────read 标记回写───────────│
   │ TeamDelete (lead)        │                            │
   │────shutdown_request────▶ │──────投递─────────────────▶│
   │                          │                 UI 确认（approve）
   │                          │◀────优雅退出/事件───────────│
   │ 删除 TeamFile+mailbox ◀───│                            │
```

## 三、共享任务列表（runtime）

- 新增工具：`TaskCreate({ subject, description? })`、`TaskUpdate({ taskId, status?, owner? })`、`TaskGet({ taskId })`、`TaskList()`。
- 存储：`<team-dir>/tasks.json`，与 TeamFile 同级、同写入所有权（runtime）。
- 与 `TodoWrite`（会话私有、无身份）互不混用；共享任务带 `owner`（成员名），认领即写 owner，避免双领：更新以版本号 CAS，冲突返回明确错误。
- 任务状态机：`pending → in_progress → completed | cancelled`；只允许按序迁移，回退需显式 `owner` 变更。

## 四、权限同步（shared / ui）

- `ZCodeInteractionRequestOrigin`（`packages/shared/src/zcode-protocol-legacy-types.ts`）扩展：既有 `kind: "subagent"` 增加可选 `teamName?` / `teammateName?` 字段（向后兼容，不新增 kind，下游 `switch` 不破坏）。
- `InteractionRequestOriginBadge.tsx`：`teamName` 存在时显示「队友名 · 团队名」徽标并着成员色。
- teammate 权限请求经 lead 的 UI bridge 呈现（同 subagent 既有链路），无新增通道。
- 团队级权限路径（v1）：TeamFile 预留 `teamAllowedPaths?: [{ path, toolName }]` 字段，spawn 时注入 teammate 权限上下文；编辑入口 v1 不做 UI，仅协议承载。

## 五、UI（packages/ui）

- **Team roster 视图**：v4 侧面板新增「团队」区块（或复用 WorkflowRoster 布局），展示成员（名称、颜色、isActive、当前任务）；数据经 services 只读发现 + 协议事件刷新，遵守「UI 局部状态不充当服务端事实」。
- **Renderer**：`tool-identity.ts` 注册新工具与 family；`SendMessage`/`TeamCreate`/`TeamDelete` 复用/新增 ToolCallBlocks renderer；共享任务列表组用统一 family 渲染（unknown fallback 仅作兜底）。
- **入口**：lead 在会话中经工具自然触发；设置页 v1 不新增管理页（roster 即视图）。
- 遵守 `DESIGN.md`、桌面/手机 Web 双端布局、i18n（en-US/zh-CN 同步补齐）；组件经 `packages/ui/src/hooks/` 访问服务，不直连 `window.zcode`。

## 六、协议与共享类型（packages/shared）

`ZCODE_KNOWN_TOOL_NAMES` / family 新增：`TeamCreate`、`TeamDelete`、`TaskCreate`、`TaskUpdate`、`TaskGet`、`TaskList` → 新 family `team`；zod schema 随协议文件同步，附运行时校验。

## 验收场景

- **AC1** `TeamCreate` 后磁盘存在 TeamFile，含 lead 成员；同名重复调用幂等返回既有团队。
- **AC2** `Agent({team_name,name})` 生成 teammate 并出现在 roster；同名重复 spawn 报错。
- **AC3** teammate→teammate 单发与 `*` 广播按序到达；广播时单成员写失败不阻断其余成员；消息带 read 标记。
- **AC4** teammate 触发权限请求时，UI 徽标显示「队友 · 团队」；批准后 teammate 继续，拒绝即收到拒绝。
- **AC5** shutdown_request 被拒后 teammate 继续运行；批准后退出并从 roster 移除；TeamDelete 清理 TeamFile 与 mailbox。
- **AC6** 共享任务列表：两人竞领同一任务时仅一方成功（CAS 冲突报错）；状态不可跳迁。
- **AC7** lead 会话结束时，未清理团队被会话清理钩子回收（孤儿团队不跨会话残留）。
- **AC8** 远程 workspace：团队目录按 workspaceIdentity 隔离，远程会话创建的团队经 `remoteSessionId` 关联，不与本地混写。
- **AC9** UI：roster 在桌面与手机 Web 布局可用；i18n 双语完整；类型检查与 lint 通过。

## 平台边界与日志

- UI→服务一律经 `packages/ui/src/hooks/` 与 `IPlatformService`；services→runtime 仅经公开入口，禁止跨域引用实现细节（架构检查覆盖）。
- 日志：runtime 侧用 `createServiceLogger("agent-teams")`；`debug` 记 mailbox 原始读写与轮询，`info` 记成员增删与关停结果，`warn` 记审批超时/写锁重试。不落凭据与用户数据。

## 实施顺序

1. shared：工具名/family/origin 扩展 + spec 同步。
2. runtime：TeamFile 存储与 TeamCreate/TeamDelete → teammate spawn 路径 → 邮箱与路由 → 共享任务列表 → 权限注入。
3. services：只读发现服务（含测试）。
4. ui：renderer → roster 视图 → badge → i18n。
5. 每步执行 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`；行为改动补对应测试，交互改动补 E2E 场景。
