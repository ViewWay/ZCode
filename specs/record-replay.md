# Spec：Record & Replay（浏览器操作录制回放）

对齐 MiMo 的 RpAutomation / record-and-replay 插件：把受控浏览器中的操作录制为可回放
automation，与 Bots/Cron 调度复用。

## 目标

1. 用户在受控浏览器（browser-use 插件）中的操作可录制成**步骤化 action 列表**。
2. 录制结果保存为 automation，可在 Bots（`packages/ui/src/BotsDialog.tsx`）中手动
   触发回放。
3. 回放产出报告：逐步骤截图 + 成功/跳过/失败状态。extract 步骤另有数据面（v1.2）：
   执行结果为页面快照的序列化 JSON（执行器侧截断到 16K 字符），以步骤 `label`
   （缺省 seq）为键写入报告条目的 `label`/`data` 字段，作为回放的数据产出。

## 现状与增量

MiMo 对标物（`automation-plugins/` 签名包 + `RpAutomation` 渲染页）为闭源参考；本仓
已有素材链路：

| 项         | 现状                                                                                               | 增量                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 浏览器录制 | `packages/desktop/src/host/browserRecordingArtifactMaterializer.ts` 已把浏览器录制物化为 artifacts | v1.1：实时采集为结构化步骤（navigate/click/type/scroll/wait），经采集会话落库（见「实时采集」） |
| 调度       | `packages/desktop/src/scheduler/`（`schedulerProtocol.ts`、off-peak 结算）                         | automation 作为调度对象接入，复用现有 Bots 生命周期                                             |
| UI         | `BotsDialog.tsx`                                                                                   | 新增"录制"来源条目与回放触发按钮                                                                |

## 数据模型（v1 实现契约）

类型与运行时校验（Zod）收口在 `packages/shared/src/automation-recording.ts`，跨
host / services / UI 复用（camelCase，与 `automation-types.ts` 同风格）：

```text
AutomationRecording:
  id（文件安全字符集 [A-Za-z0-9._-]，由存储层生成）
  createdAt（ISO 8601 字符串）、title?、source: "browser" | "cua"（v1 仅 browser）
  steps: AutomationRecordingStep[]
AutomationRecordingStep:
  seq（>=1，回放按 seq 升序）
  action: navigate | click | type | wait | scroll | extract
  target?: { kind: "selector", selector } | { kind: "point", x, y }   // selector|坐标
  value?: string        // navigate=URL、type=输入文本
  durationMs?: number   // wait 专用：等待毫秒
  deltaY?: number       // scroll 专用：纵向滚动像素（负值向上）
  screenshot?: string   // 录制期该步截图的相对路径（录制采集方写入，回放只读）
```

字段约束（schema refine）：navigate 必填 value；type 必填 selector target + value；
click 必填 target；wait 必填 durationMs；scroll 必填 deltaY；extract target 可选
（缺省整页 snapshot）。

- 存储位置：`~/.zcode/automations/<id>.json`（存储层为唯一写入点；staging 文件 +
  rename 原子提交，Windows 先删目标再 rename，同 `browserRecordingArtifactMaterializer`
  范式）；回放报告写 `~/.zcode/automations/reports/<recordingId>/<runId>.json`，
  失败截图写同目录 `<runId>-step-<seq>.png`。目录可注入（rootDir），跨平台用 node:path。
- 录制文件损坏（非法 JSON 或 schema 不通过）时读取即抛结构化错误，回放拒绝执行，
  不允许部分步骤执行。
- 与 `~/.zcode/v2/bot-config.v3.json`（Bots 聊天渠道配置）不混写；录制件只通过
  本 spec 的服务面与 scheduler 域交互。

## 回放引擎（v1 实现契约）

- 执行面定义为可注入接口 `BrowserActionExecutor`（`packages/desktop/src/host/automationReplayExecutors.ts`）：
  - `executeStep(step)` 结构化返回 ok/error，不 throw；
  - `captureScreenshot()` 供失败截图，尽力而为；
  - `surface` 标识执行面（报告记录，便于诊断接线来源）。
- 真实执行面适配器 `createBrowserCommandActionExecutor`：把步骤映射为既有
  `BrowserCommand`（navigate/snapshot/click 坐标/scroll/playwright locator fill+click），
  经注入的 `executeCommand` 派发——与 host↔main 的 `browserControlMainBridge.execute`
  同一契约。宿主内没有可用的受控浏览器执行链路（会话获取失败）时，回退
  `createUnavailableBrowserActionExecutor` 返回结构化 unavailable 错误（诚实失败，
  不伪造成功），报告 `executorSurface` 说明原因。
- 回放浏览器会话 `acquireAutomationReplayBrowserSession`
  （`packages/desktop/src/host/automationReplayBrowserSession.ts`）：每次回放构造
  host 拥有的临时 browser scope——sessionId=`automation-replay:<runId>`（与报告 runId
  对账），workspace 身份沿用窗口 Host 的 `workspaceIdentity?.trim() || workspacePath`；
  步骤与截图经 `browserControlMainBridge.execute` 派发。main 侧
  `BrowserGuestManager` 按 scope（browserId/generation/windowId/workspaceKey/
  remoteSessionId/sessionId/clientMode）隐式创建 agent tab 并由 renderer 后台挂载
  guest（不抢当前对话焦点），owner/scope/guest 校验边界完全复用既有链路，不新增
  main 侧 API。
- 会话生命周期：回放开始先派发一条 `list` 命令 preflight 验证 host→main 链路；
  失败即回退 unavailable 执行面。回放结束/失败必须在 finally 中释放：list 出
  scope 内 tabs 后逐个 `close`（不遗留 claimable user tab）；释放本身尽力而为，
  失败仅告警，不影响已落盘的报告。
- 引擎逐步执行（seq 升序）；`wait` 由引擎本地延时（可注入 delay）；其余动作派发执行器。
- 失败策略：默认截图 + 中断（报告 status="failed"）；可配 `onFailure:"skip"` 记
  skipped 继续。中断时已执行步骤与失败截图保留在报告中。
- 回放状态只进报告文件，不回写 recording。

## 实时采集（v1.1 实现契约）

录制链路的最后一环：用户在受控浏览器中的操作实时采集为步骤流，停止后落库为
`AutomationRecording`（存储沿用 v1 契约，不新增写入路径）。

### 采集通道（选择与依据）

三选一结论：**host 侧结构化采集（页面事件采集脚本 + host 轮询 drain）**，全部经
既有 `browserControlMainBridge.execute` 派发，零 main 侧改动。

- main 侧 CDP 事件订阅转发：需在 shared 协议新增 host↔main 请求/推送消息类型、
  `desktopHostProcess` 分派、main/index 装配与 `BrowserGuestManager` 公开订阅 API +
  CDP 注入，改动面跨 5 处进程边界，超出「最小增量」收益，不采用。
- host→renderer 浏览器面板交互事件：guest 是独立 WebContentsView，用户输入直达
  guest 页面，renderer 面板不产生页面内容交互事件，通道不存在，不采用。
- **host 侧采集（采用）**：录制 scope 内经既有 `evaluate` 命令注入只读采集脚本
  （监听 click/change/wheel/popstate/hashchange，主框架），事件缓存在页面内存；
  host 每 `pollIntervalMs`（默认 1000ms）经 `evaluate` drain（自安装：脚本不存在则
  先安装再返回），返回值在 host 侧经 Zod 校验（`automationCaptureRawEventSchema`）
  后进入映射。owner/scope/guest 边界完全复用既有执行链路。

### 采集会话与生命周期

- 会话 scope 复用回放会话同款机制：sessionId=`automation-record:<captureId>`，
  workspace 身份沿用窗口 Host 的 `workspaceIdentity?.trim() || workspacePath`；
  preflight `list` 验证链路，失败即结构化拒绝（诚实失败）。
- 启动：preflight → `newTab`（fresh tab，初始 about:blank，用户在嵌入面板内自行
  导航）→ `activateTab` + `browserVisibilitySet(true)`（用户可见可操作，尽力而为）
  → 首次 drain 安装脚本。
- 轮询：drain 返回 `{ url, events }`；URL 与上次不同 → 追加 navigate 事件
  （ts 取 drain 事件首时间戳-1，无事件则取轮询时刻），覆盖 SPA pushState 兜底；
  drain 失败（导航中 context 销毁等）只告警，下轮重试。同一时刻最多一个活动采集
  会话（服务面 startCapture 重入即拒绝）。
- 停止/取消：最终 drain（尽力而为）→ 停表 → 释放（`browserVisibilitySet(false)`
  - list 出 scope tabs 逐个 close，尽力而为）。停止后步骤为 0 时保存拒绝并报
    `no steps captured`。页面事件缓冲上限 500 条/文档，导航前最后一个轮询窗口内的
    事件可能丢失（跨文档缓冲不持久化），v1 接受并在停止前做最终 drain 缓解。

### 步骤映射与噪声过滤（v1.1 最小集）

映射集：`navigate`（URL 变化/初始导航）、`click`（selector 优先，CSS 逃逸构造；
失败回退视口坐标 point）、`type`（input/textarea/select 的 change 提交值，整段
fill 语义）、`scroll`（wheel 聚合，页面侧 500ms 空闲去抖）、`wait`（相邻步骤间隔
≥2000ms 时插入，封顶 60000ms）。`extract` 延后 v2。

噪声过滤（纯函数 `mapCaptureEventsToSteps`，窗口可注入）：

- 连击合并：同 selector（或同坐标）点击间隔 ≤500ms 合并为一步。
- 同字段连续 change：同 selector 间隔 ≤500ms 取后值（最终值语义）。
- scroll 合并：同方向相邻 scroll 间隔 ≤800ms 求和（±100000 截断）。
- 步骤总数上限 500（schema 上限），超出截断。

已知限制（v1 接受，v2 增量）：仅主框架（iframe 内操作不采集）；contenteditable
不采集（change 不触发）；Enter 提交表单不产生步骤（需点击提交按钮）；采集脚本
随导航销毁重装。

### 隐私

录制值（含密码框等敏感输入）原样进入步骤与录制文件（回放需要真实值，不做脱敏
伪造）；代价是**录制前 UI 必须明示并经确认**（BrowserRecordingsCard 开始录制
确认弹窗，文案包含「输入内容（含密码）会被原样记录」）；存储沿用 v1 目录
（`~/.zcode/automations/`）权限。日志不落步骤值。

## 服务面与 UI 接入（v1 实现契约）

- `IAutomationRecordingService`（descriptor 经 `ServiceChannels.AutomationRecording`）：
  `list/get/save/delete/replay/listReports`（v1）；v1.1 采集面：
  `startCapture({title?})/getCaptureState()/stopCapture()/cancelCapture()`；由
  Desktop 本地 Host 实现（存储与引擎在 `packages/desktop/src/host/`），注册进
  window Host 的 ServiceCollection；远端/Host 不提供时 UI 隐藏该区。
- UI 落点为「自动化」页（`AutomationsSection.tsx`）已创建任务区之后的
  「浏览器录制」卡片（`BrowserRecordingsCard.tsx`）：条目标 `recording` 来源、
  步骤数与创建时间，提供手动回放与删除按钮；v1.1 增加录制入口（开始录制 →
  隐私确认 → 录制中状态条（步数/URL 轮询 `getCaptureState`）→ 停止并保存 /
  取消）。BotsDialog 的数据面是聊天渠道 bot-config.v3.json，与 scheduler
  协议无关，按禁令不并入录制条目。

## 状态所有者与数据流

```text
浏览器会话（automation-record scope，用户交互）
  → 页面采集脚本（主框架，事件缓冲）→ host 轮询 drain（evaluate）→ 原始事件（Zod 校验）
  → 步骤映射（纯函数，去抖/合并）→ stopCapture → AutomationRecording
  （~/.zcode/automations/<id>.json，唯一写入点，store.save 复用）
  → 手动触发回放（v1；cron 周期回放放后续增量）→ 回放报告（截图目录 + 状态 JSON）
```

- 活动采集会话的唯一所有者是 Desktop 本地 Host 的 automation-recording 服务
  （同一时刻至多一个）；renderer 只经服务面读状态与发命令，不自存采集事实。
- recording 文件是唯一事实源；回放状态只进报告文件，不回写 recording。

## 非目标（v1 边界）

- 不做桌面级 CUA 操作录制（zcode-cua 开源侧为占位实现，CUA 回放放 v2）。
- 不做录制步骤编辑器；v1 只能整体回放或删除。
- 不做跨设备同步录制件。
- v1.1 已实现浏览器交互实时采集（见「实时采集」）；CUA 采集、iframe/
  contenteditable 采集、`extract` 步骤与 cron 周期回放放后续增量。
- v1 回放触发仅手动（UI 按钮）；cron 周期回放复用 automation 调度放后续增量。

## 验收场景

1. 录制一轮网页操作（打开页→点击→填表→提交）→ 保存为 automation → Bots 里手动触发
   回放成功并产出带截图的报告。
2. 回放中目标页面结构变化导致选择器失效 → 报告标记该步失败并附截图，不静默错乱。
3. 录制文件损坏时回放拒绝执行并提示，而非部分执行。
4. 实时采集：开始录制（隐私确认后）→ 用户在嵌入浏览器操作（导航/点击/输入/滚动）
   → 停止并保存 → 列表出现新录制件，步骤含 navigate/click/type/scroll，间隔处含
   wait；重入 startCapture 被拒绝；取消不落库。

## 验证

- 回放引擎单测：固定步骤序列 + 本地测试页，断言逐步执行与失败策略。
- 采集单测：步骤映射纯函数（连击合并/字段取后值/scroll 聚合/wait 插入/截断）与
  采集会话生命周期（fake bridge：preflight 失败、启动命令序列、轮询 drain、
  URL 变化补 navigate、停止/取消释放）。
- E2E：录制-保存-回放闭环（本地测试页）。
- `pnpm typecheck`；`pnpm architecture:check --changed`。
