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
3. teammate 间邮箱消息（peer-to-peer + 广播 + teammate→lead），与既有 parent→child steering 并存。
4. 共享任务列表工具组（TaskCreate/TaskUpdate/TaskGet/TaskList）。
5. 团队级权限路径与 UI roster 视图。

## 领域词汇

- **Lead**：创建团队的会话（主 agent），团队唯一协调者。
- **Teammate**：具名常驻代理，由 `Agent({ team_name, name })` 生成，有自己的消息循环，空闲时待命不退出。
- **TeamFile**：团队注册表 JSON（磁盘事实源）。
- **Mailbox**：成员收件箱队列（按成员命名的 JSON 文件，文件锁互斥写入）；lead 的收件箱（`inboxes/team_lead.json`）由 runtime 的 lead 邮箱消费循环读取，teammate→lead 消息不再是死信。
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
- 新增工具 `TeamDelete({ name })`：向全部存活 teammate 发 shutdown_request，等待审批结果（有 UI bridge 时弹确认，超时 30s 视为拒绝并强制终止），随后删除 TeamFile 与 mailbox。实现收敛在 `SubagentPort.shutdownTeam`（runtime 单一写入者）：写 shutdown_request → 轮询 TeamFile 等成员收敛到仅剩 lead（上限 30s）→ 强制 abort 未退出 teammate → 删除团队目录并停止 lead 消费循环。工具 handler 优先走端口实现，端口/teammate 运行时缺失时回退为「仅删目录」。

### 存储约定（磁盘为唯一事实源）

- 目录：`<home>/.zcode/teams/<workspace-key>/<team-name>/`；`workspace-key` 由身份键 `workspaceIdentity?.trim() || workspacePath`（AGENTS.md Workspace Identity 规则）经 sha256 取前 12 位 hex 派生（与 repo-wiki 目录哈希约定一致——身份值可能含文件系统非法字符，不能直接作目录名）。
- `config.json`（TeamFile）：`{ name, description?, createdAt, leadAgentId, leadSessionId?, members: [{ agentId, name, color?, permissionMode?, cwd, sessionId?, isActive, joinedAt }] }`；`color` 复用 `packages/services/src/subagents/subagentMarkdown.ts` 的 8 色板。
- `inboxes/<member-name>.json`：消息数组（见下节）；`locks/<resource>.lock`：文件锁（O_EXCL 独占创建 + 指数退避重试 + 陈旧锁按 mtime 打破），保证多写者互斥；所有 JSON 落盘一律 tmp → rename 原子写。
- services 层（`packages/services`）只提供**只读发现/解析**（供 UI roster 与设置页展示），不新增第二条写入路径——写所有权归 runtime。
- 共享任务解析规则（v1）：Task* 工具作用于 workspace 内**唯一**团队；零个/多个团队时返回明确错误要求先收敛（TeamCreate / TeamDelete），不在工具入参引入第二个 team 选择器。

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
| `shutdown_request` | `{ type, reason }` | teammate 弹 UI 确认；approve → 优雅退出并从 roster 移除，向 lead 邮箱回 `shutdown_response`；reject → 回执拒绝，继续运行 |
| `shutdown_response` | `{ type, approve }` | 仅 lead 消费：teammate 批准关停的回执，经 lead 邮箱消费循环回灌 lead turn，lead 由此确认关停结果 |
| `idle_notification` | `{ type, idleReason? }` | teammate active→idle 翻转时写入 lead 邮箱，经消费循环回灌 lead turn（防 lead 盲等） |
| `plan_approval_request/response` | `{ type, request_id, approve }` | v1 由 UI bridge 同步链路承载（同 AC4 徽标链路），不走邮箱；mailbox schema 保留给 v2 非 in-process 后端，监督循环遇此载荷显式跳过（标记已读，不注入 turn） |

投递语义：至多一次 + 确认读（read 标志）；轮询间隔 1s；广播对每个成员独立落盘，单成员失败不阻断其他成员；**lead 的收件箱由 runtime 的 lead 邮箱消费循环读取**（首个 teammate spawn 时启动，TeamFile 被删后自停），消费产物经既有父任务通知队列回灌 lead turn——mailbox 仍是消息事实源，消费循环不创建第二个事实源。

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

### 时序（lead 收件箱消费 + idle 通知 + 关停回执）

```text
TeammateSupervisor            lead mailbox            LeadInboxPoller         父通知队列 → lead turn
   │ turn 完成 active→idle       │                         │                      │
   │──idle_notification───────▶│                         │                      │
   │                            │────1s 读未读(markRead)──▶│                      │
   │                            │                         │──格式化通知入队──────▶│
   │ shutdown_request 批准       │                         │                      │
   │──shutdown_response───────▶│                         │                      │
   │──removeTeamMember────────▶│                         │                      │
   │ teammate SendMessage(lead) │                         │                      │
   │──text─────────────────────▶│                         │                      │
```

lead 消费循环由 runner 端口闭包持有：首个 teammate spawn 时启动（此时 enqueueParentTaskNotification 必须在场），TeamFile 被删除后自停；lead 会话 beginShutdown 时随 AC7 清理一并终止。

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

## 实施状态

- **runtime 存储层与团队工具面（已落地，tests: `apps/zcode-cli/packages/core/test/team/`）**：
  - contracts（`apps/zcode-cli/packages/contracts/src/tools/team.ts` / `team-task.ts`）：TeamCreate/TeamDelete 与 TaskCreate/TaskUpdate/TaskGet/TaskList 的 zod 契约、名字约束（`TEAM_NAME_PATTERN`，跨平台安全由 `isSafeTeamPathSegment` 补 Windows 保留名/分隔符校验）、成员上限 8、shutdown 审批超时 30s。
  - core（`apps/zcode-cli/packages/core/src/subagent/team/`）：`team-paths.ts`（workspace-key 哈希与目录解析）、`team-lock.ts`（文件锁）、`team-json-file.ts`、`team-store.ts`（TeamFile 幂等创建/成员注册/上限/删除）、`team-mailbox.ts`（单发/确认读/广播隔离）、`team-tasks.ts`（CAS + 状态机）。
  - handlers（`apps/zcode-cli/packages/core/src/tool/handlers/team-create.ts` / `team-delete.ts` / `team-task.ts`）：注册门 `includeTeam` / `includeTeamTasks`（主会话 `taskType !== "subagent_child"` 且 subagentPort 在场；无嵌套团队）。
  - TeamDelete v1：清理事实源 + 幂等 `not_found`；`shutdownRequested` 字段先行固定 wire 形状，shutdown 投递随 teammate 运行时接入。
- **待办（v1 已全部闭环，2026-09-25 会话）**：teammate 常驻生成路径、SendMessage 队友路由与广播、teammate 邮箱轮询、权限徽标（shared origin 扩展）、services 只读发现、UI roster/renderer/i18n —— 均已落地。
- **teammate 常驻运行时（已落地，未提交工作区）**：
  - contracts：`teammate-spawn.ts`（`TeammateLaunchedOutput`）、`subagent.port.ts`（`spawnTeammate` 端口 + `SubagentRunRequest` 可选 `teamName`/`teammateName`）。
  - `tool/handlers/agent.ts`：`team_name`+`name` 路由 teammate 生成；`tool/handlers/send-message.ts`：`deliverToTeamMailbox` 团队成员寻址 + `*` 广播（单团队解析规则，命中即短路既有 agentId 路由）。
  - `subagent/runner.ts`：`spawnTeammate`——先写 TeamFile 成员再启动首轮 turn（与 spec spawn 顺序一致），首轮完成交 `teammate-supervisor` 接管；resume 管线续用消息携带的 `traceContext`。
  - `subagent/team/teammate-supervisor.ts`：终态探测翻转 `isActive`、邮箱轮询消费 `newlyRead`、shutdown_request 审批退出、abort 即摘除成员（TeamDelete/会话终止路径）。
  - 修复依据（双重 resume）：`readTeamInbox` 返回「已消费视角」，监督循环若按整表消费会在下一轮终态探测重放历史消息；`TeamInboxReadResult` 新增 `newlyRead` 表达「本次轮询新到达」边界（tests: teammate-supervisor 用例 1 回归覆盖）。
  - traceContext 续链：mailbox 消息携带发送方 trace（`TraceContext`），恢复 turn 时续链，保证 traceId 不断裂。
- **AC4 权限徽标（已落地）**：shared `zcodeInteractionRequestOriginSchema` 的 `subagent` kind 增加可选 `teamName`/`teammateName`（strict schema 加字段向后兼容）；runtime 经 `SubagentInteractionOriginContext` → `deriveChildClientPorts` 穿线；UI `InteractionRequestOriginBadge` 按「队友 · 团队」分流。
- **services 只读发现（已落地，tests: `packages/services/test/teamsDiscovery.test.ts`）**：`packages/services/src/teams/`（`ITeamsService` 描述符、`teamsPaths.ts` 与 runtime 同构哈希并钉住样例向量、`teamsDiscoveryService.ts` 宽松归一 + 坏文件跳过）；通道 `ServiceChannels.Teams`；desktop host 注册于 `remoteWorkspaceServiceCollection.ts`，client 经 `remoteServiceAccess.ts` 代理。
- **UI（已落地）**：family `team` 渲染器（`renderers/team.tsx`，6 工具共用）、侧栏「团队」区块（`WorkspaceSidebar/TeamRosterSection.tsx` + `useTeamRoster` 2.5s 轮询，无团队时隐藏）、roster/i18n 双语键。
- **cc-haha 对比闭环（2026-09-25 会话，已落地）**：对比 NanmiCoder/cc-haha 仓库（`docs/internals/agent.md`、`agent-internals.md` 与 `src/utils/swarm/` 源码）后确认四类差距并闭环：
  1. **lead 收件箱消费循环**（`subagent/team/lead-inbox-poller.ts`，新增）：teammate→lead 的消息此前是死信（无人消费 inboxes/team_lead.json）。消费循环在首个 teammate spawn 时启动，TeamFile 删除后自停，每条新消息经既有父任务通知队列（enqueueParentTaskNotification，originMeta.backgroundSource="subagent"）回灌 lead turn；mailbox 仍是唯一事实源，确认读防重放。
  2. **idle_notification**：监督循环在 active→idle 翻转时向 lead 收件箱写 idle_notification（idleReason=available），lead 不再盲等（对齐 cc-haha Stop-hook 语义）。
  3. **shutdown_response 回执**（AC5 闭环）：teammate 批准关停后向 lead 收件箱回执，lead agent 据此确认关停结果。
  4. **TeamDelete 完整语义（AC5）+ AC7 会话清理**：`SubagentPort.shutdownTeam`（contracts 新接口）由 runner 闭包实现：投递 shutdown_request → 轮询 TeamFile 等成员收敛（上限 30s，TEAM_SHUTDOWN_APPROVAL_TIMEOUT_MS）→ 强制 abort 残留者 → 删目录（`subagent/team/team-shutdown.ts`）；TeamDelete handler 优先走端口，无运行时时回退「仅删目录」。AC7：lead runtime `beginShutdown` abort 会话 teardown 信号（`getSessionTeardownSignal`），runner 闭包监听后 abort 全部 teammate 并删除本会话创建的团队目录，孤儿团队不跨会话残留。
  - **plan_approval 设计决策**：v1 teammate 计划审批由 UI bridge 同步链路承载（同 AC4 徽标链路），不走邮箱——与 cc-haha in-process 队友走共享权限管线同理；cc-haha 的邮箱配对只为 tmux/iTerm2 外部后端服务。mailbox schema 保留，监督循环显式跳过该载荷。
  - **AC8 验证结论**：事实源半边正确（团队目录按 workspaceIdentity 键隔离，teamsPaths 测试钉住样例向量；远程会话的 CLI 在远端写远端目录，不混写）。发现半边 v1 与 subagents 服务同位注册（remoteWorkspaceServiceCollection；远端 agent 侧 Teams 通道注册缺失，远程窗口 roster 读本地目录——v1 已知边界，client 代理 `RemoteServiceAccess.teamsService` 已就绪，v2 需 agent 连接侧注册通道）。
- **验证基线**：core team 测试 25 + services discovery 测试 4 全绿；根 `pnpm typecheck` 通过（exit 0）；根 `pnpm lint` 0 errors/70 warnings（基线）；core oxlint 对本次文件 0 新告警（max-lines 类超标如 agent-runtime.ts 677 行为既有基线，改动前 664 行）；`architecture:check --changed` 0 violations。


## 实施状态（v2 增量，2026-09-26）

**铺设层（已落地）**：contracts `SubagentRunRequest.workspaceIdentity`；runner `ExploreSubagentRuntimeRequest.workspaceIdentity`、`runExploreAgent` 参数穿线、`resumeRequest` 从任务快照恢复身份、`createRuntimeTaskSnapshot` 写入身份；`RuntimeTaskSnapshot` 增 teamName/teammateName/workspaceIdentity；`AgentRuntimeConfig.teamMemberIdentity`（声明合并）；methods/subagent.ts child runtime 配置穿线两者（workspaceIdentity 按原值回铸 WorkspaceId，不经 createWorkspaceId 以免前缀漂移）。

**收口（本次补丁，源自 agent-teams-v2-patches.json）**：runtime-tools 门控按 `config.teamMemberIdentity` 放行 teammate 会话的 SendMessage 与共享任务列表（TeamCreate/TeamDelete 仍主会话专属）；executor/impl/call-runner 三层透传到工具上下文；`send-message.ts` 发送方身份按会话解析（主会话=team_lead，teammate=成员名），member 未命中时 teammate 会话抛明确业务失败、主会话保持回落 agentId 路由；新增 teammate 身份辅助函数单测。

**语义修正**：第三节「团队内所有成员可读写」在 v1 实现中不成立（v1 门控仅主会话注册 Task* 工具），v2 落地后成立。

**后续路线**：P1 任务依赖（blockedBy/ready）与空闲自动认领、teammate 系统提示词契约、teamAllowedPaths 实际注入；P2 技能/知识共享（团队知识目录或项目 memory，SKILL.md 式文档 + 索引注入，TeamDelete 后归档项目 memory，复用 src/memory extraction/recall）；P3 质量门（评审 verdict + 修复循环）、计划审批走邮箱、DAG 活动面板。

### v2.1 增量（2026-09-26）：任务状态迁移通知 lead

`TaskUpdate` 使任务迁到 completed/cancelled、或从终态重开时，runtime 向 lead 收件箱投递 `task_notification`（发送方=操作者身份：主会话=team_lead，teammate=成员名）；lead-inbox-poller 将其格式化进 lead turn（如 `alice completed task "..." (task_id).`）。认领/进行中不通知以避免噪声；通知为 best-effort，投递失败不回滚状态迁移。这补齐正反馈闭环的输入侧：lead 对成员完成情况拥有一等信号，派发决策不再依赖轮询 TaskList。

### v2.2 增量（2026-09-26，P1：依赖与自动认领）

**任务依赖**：`TeamTask.blockedBy`（taskId 数组，TaskCreate 时设定并校验存在性与去重；全部 completed 即 ready，缺失的依赖任务视为不满足）。

**阻塞语义**：依赖不满足时迁往 `in_progress` 被拒（`team_task_blocked`）；已在 in_progress 的任务不受影响（兼容依赖设定前已认领的任务）。

**自动认领**：空闲 teammate（任务终态）经 `claimNextReadyTask` 认领首个「pending、无 owner、ready」任务（文件锁 + CAS 竞争防护；争抢失败返回 undefined 保持空闲）。认领成功立即 resume 新 turn 且**不发 idle 通知**（马上又开工，通知无意义）；无可认领才进入空闲通知。默认开启；lead 随时可重派（owner 变更 bumps attempts 并记录 reassignedAt）。

**正反馈计数**：owner 变更或终态重开时 attempts+1（客观计数，无主观评分），供 lead 派发参考。

### v2.3 增量（2026-09-26，P2：团队知识库——学会并共享新技能）

**存储**：`<team-dir>/knowledge/<slug>.md`（SKILL.md 式 frontmatter：when_to_use/author/updated_at + 正文）；写入为覆盖语义允许迭代；目录上限 200 篇；slug 走 isSafeTeamPathSegment 校验（跨平台路径安全）。

**工具面**：`TeamKnowledgeWrite({slug, when_to_use, content})` / `TeamKnowledgeSearch({query, limit?})`；注册门与共享任务一致（includeTeamTasks，lead 与 teammate 可用）；写入方身份按会话解析。检索为大小写不敏感子串匹配（Voyager-lite，无 embedding），返回命中行片段。

**协作循环**：成员解决非显然问题后 → TeamKnowledgeWrite 沉淀；任何成员开工前/卡住时 → TeamKnowledgeSearch 先检索复用，再向 lead 求助（已写入 teammate 系统提示词）。

**边界**：TeamDelete 归档（知识不随团队消散）列入后续批次（当前 TeamDelete 仍整目录删除）；UI 未注册专用 renderer，走 unknown fallback（仅显示层，工具功能完整）。

### v2.4 增量（2026-09-26，P3：验收-返工环）

**验收判定**：`TaskUpdate` 新增 `reviewVerdict`(approve/revise)与 `reviewComment`,仅适用于 status=completed 的任务(否则 team_task_review_requires_completed);revise 必须带意见(team_task_review_comment_required)。

**语义**：approve → 记录 reviewStatus=approved,状态不变;revise → 任务自动回退 in_progress(免 owner 变更)、attempts+1,验收意见以文本消息送达 owner 收件箱(owner 的监督循环消费文本并恢复 turn——成员由此知道改什么)。review 通知为 best-effort。

**闭环**：完成通知(v2.1)→ lead 验收(v2.4)→ 返工回派/通过 → 成员收到评审文本——正反馈闭环双向贯通。TeamCreate 输出追加「lead 协调而非施工」提示(Anthropic 多代理工程复盘教训)。

### v2.5 增量（2026-09-27，P2 收尾）：知识归档与 UI 注册

**知识归档**：TeamDelete/会话清理删除团队目录前，`archiveTeamKnowledge` 将 knowledge/ 移入 `<teamsRoot>/_archive/<teamName>-<timestamp>/knowledge`——团队解散,知识不散;归档 best-effort,失败不阻断删除。

**UI 注册**：`TeamKnowledgeWrite/TeamKnowledgeSearch` 登记进 shared `ZCODE_KNOWN_TOOL_NAMES` 与 team family 映射,UI 复用 `TeamToolCallBlock` 渲染,不再走 unknown fallback。

**单测**：补 `formatLeadInboxNotification` 的 task_notification 格式化分支(完成/重开)。

### v2.6 修复（2026-09-27）

1. **就绪语义**：cancelled 依赖视为解除阻塞（依赖被砍=不再阻塞，是否重排由 lead 决定）；缺失依赖视为不满足。环防御：blockedBy 创建后不可变（不可引用未来任务），当前无环可能；未来开放依赖修改时必须在 isTaskReady 加环检测。
2. **自通知过滤**：lead 主会话自己的任务操作不回写 lead 收件箱；评审意见不给评审人自己发（handler 侧按 actor 过滤）。
3. **孤儿任务防护**：成员被中止（TaskStop/中止信号，团队与任务板仍存活）时，`releaseMemberTasks` 将其 in_progress 任务释放回任务池（清 owner、attempts+1）并通知 lead 重新调度；TeamDelete 整队删除场景无需释放。
4. **关停审批注入点**：shutdown_request 缺省自动同意（TeamDelete 为 lead 权威语义，v1 spec 的「审批」描述据此修正）；supervisor 预留 `onShutdownRequest` 注入点，未来接 UI 审批时返回 false 即拒绝（回执 reject，成员继续运行）。

**backlog 追加**：待验收聚合信号、auto-claim 开关、成员 currentTask 可观测、知识库去重/过期/更新推送、归档目录清理策略、mailbox 上限。

### v2.7 增量（2026-09-27，P2 收尾）：通知聚合与 worktree 隔离

**通知聚合（join 策略对齐 pi-subagents）**：`LeadInboxPollerInput.aggregationWindowMs`（缺省 0=逐条，向后兼容）。>0 时窗口内多条通知合并为一条批量投递（`[Team x] N updates from teammates:` + 逐条格式化行），10 条上限或窗口到期即投递；单条窗口内保持原格式；退出前清空缓冲防丢通知。

**worktree 隔离（对齐 cc-haha worktreePath / pi-subagents）**：`TeamCreate({ useWorktree: true })` 后，成员 spawn 即在 `git worktree add` 出的独立副本工作（`<teamsRoot>/worktrees/<team>/<member>`，分支 `zcode/<team>/<member>`）——多成员并行改同一仓库不再互相踩踏。创建失败自动降级共享工作区（warn 日志）；TeamDelete/会话清理移除 worktree 工作目录，**成员分支保留**作为 lead 合并入口；git 主仓库的 worktree 元数据需 `git worktree prune` 兜底（已知边界）。git 调用收敛在 `team-worktree.ts` 单文件 IO 边界。

**通知者语义**：聚合仅改变投递形态，不改变确认读/事实源语义（mailbox 仍是唯一事实源）。

### v2.8 增量（2026-09-29）：技能提升与团队角色模板

**技能提升**：`TeamKnowledgePromote({slug, skill_name?})` 把团队知识文档改写为标准 SKILL.md 写入用户级技能目录 `~/.zcode/skills/<name>/`——跨项目可被 Skill 工具加载（当前会话不注册，新会话生效）；覆盖语义；slug/skillName 走路径安全校验。

**团队角色模板**：`TeamCreate({template})` 读取 `<workspaceRoot>/.zcode/team-templates/<name>.md`（行式 markdown：description + `## member: <name>` 段（成员 prompt）+ `## task: <subject>` 段（owner/depends/detail）），解析为 templatePlan（成员 spawn 计划 + 任务创建计划，含 owner 与 depends 提示）随输出回灌 lead 模型，lead 按剧本 Agent spawn + TaskCreate 实例化。模板名走路径安全校验；段数上限 32。

**协作闭环补全**：用户一句需求 → lead 自主选角色模板建队 → 成员按知识库/技能工作 → 经验沉淀 → 可提升为跨项目技能。
### v2.10 增量（2026-10-01，P1）：TeamPlan 计划-审批-启动

**契约**：`contracts/src/tools/team-plan.ts` 定稿 TeamPlanRecord（schemaVersion 1、teamName、sessionId、revision、state、members[≤8]、tasks[≤32]、feedback?、approvedAt?）。成员含 id/name/agentType?/prompt/model?（v1 仅记录不路由）/reason?/difficulty?；任务 owner 引用 member.name、depends 引用计划内任务 subject（自然语言键，校验存在性并拒绝依赖环）。

**状态机**：draft → review_pending → approved（cancelled 终态）。plan.json 落 `<team-dir>/`，与 config/tasks 同所有权；revision 从 1 起每次成功写 +1；全部写入持 withTeamFileLock + 原子写；replace/submit/approve 走 expected_revision CAS（team_plan_conflict）。approved/cancelled 后一切写入拒绝（team_plan_locked）；approve 仅 review_pending 可进（team_plan_not_review_pending）；submit 仅 draft 可进。

**工具面**：`TeamPlan`（get/replace/submit，needsApproval=false，注册门与 TeamCreate 同款 includeTeam=lead only）与 `TeamPlanApprove`（approve，needsApproval=true + alwaysAsk + 不允许「总是允许」——确认弹窗即人类批准面，关掉它等于让 lead 自批）。TeamPlan 收到 operation=approve 一律拒绝（team_plan_approve_gate），模型侧制度性不能绕过审批；submit 后输出明示「等待用户批准，不要开始工作、认领任务或 spawn 成员」。用户拒绝确认即驳回：lead 带 feedback 重新 replace（回到 draft）再 submit。TeamPlan 登记进 shared ZCODE_KNOWN_TOOL_NAMES（family=team，UI 复用 TeamToolCallBlock）。

**启动剧本**：approve 成功输出 launchPlan（与 v2.8 templatePlan 同构）：lead 读后 `Agent({team_name, name})` spawn 成员 + TaskCreate 按序建任务（depends 映射 blockedBy 任务 id）。

**对齐**：cc-haha v0.6.7 TeamPlanTool 的计划-审批-启动语义，裁剪为 v1 无 launching/running 等执行态（实例化由 lead 按剧本完成，运行态即团队本身）。FlowPilot dispatch=team 的编排依赖本 approved 状态作为启动前置。
