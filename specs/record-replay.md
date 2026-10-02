# Spec：Record & Replay（浏览器操作录制回放）

对齐 MiMo 的 RpAutomation / record-and-replay 插件：把受控浏览器中的操作录制为可回放
automation，与 Bots/Cron 调度复用。

## 目标

1. 用户在受控浏览器（browser-use 插件）中的操作可录制成**步骤化 action 列表**。
2. 录制结果保存为 automation，可在 Bots（`packages/ui/src/BotsDialog.tsx`）中手动
   触发回放。
3. 回放产出报告：逐步骤截图 + 成功/跳过/失败状态。

## 现状与增量

MiMo 对标物（`automation-plugins/` 签名包 + `RpAutomation` 渲染页）为闭源参考；本仓
已有素材链路：

| 项 | 现状 | 增量 |
| --- | --- | --- |
| 浏览器录制 | `packages/desktop/src/host/browserRecordingArtifactMaterializer.ts` 已把浏览器录制物化为 artifacts | 扩展为结构化步骤（action 序列：navigate/click/type/wait） |
| 调度 | `packages/desktop/src/scheduler/`（`schedulerProtocol.ts`、off-peak 结算） | automation 作为调度对象接入，复用现有 Bots 生命周期 |
| UI | `BotsDialog.tsx` | 新增"录制"来源条目与回放触发按钮 |

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
  同一契约。宿主内没有为「无会话上下文的回放」预留的受控浏览器执行 API 时，使用
  `createUnavailableBrowserActionExecutor` 返回结构化 unavailable 错误（诚实失败，
  不伪造成功）；接线缺口在实现报告中说明。
- 引擎逐步执行（seq 升序）；`wait` 由引擎本地延时（可注入 delay）；其余动作派发执行器。
- 失败策略：默认截图 + 中断（报告 status="failed"）；可配 `onFailure:"skip"` 记
  skipped 继续。中断时已执行步骤与失败截图保留在报告中。
- 回放状态只进报告文件，不回写 recording。

## 服务面与 UI 接入（v1 实现契约）

- `IAutomationRecordingService`（descriptor 经 `ServiceChannels.AutomationRecording`）：
  `list/get/save/delete/replay/listReports`；由 Desktop 本地 Host 实现（存储与引擎在
  `packages/desktop/src/host/`），注册进 window Host 的 ServiceCollection；远端/Host
  不提供时 UI 隐藏该区。
- UI 落点为「自动化」页（`AutomationsSection.tsx`）已创建任务区之后的
  「浏览器录制」卡片（`BrowserRecordingsCard.tsx`）：条目标 `recording` 来源、
  步骤数与创建时间，提供手动回放与删除按钮。BotsDialog 的数据面是聊天渠道
  bot-config.v3.json，与 scheduler 协议无关，按禁令不并入录制条目。

## 状态所有者与数据流

```text
浏览器会话（browser-use 插件）→ 录制采集（新增，host 层）
  → AutomationRecording（~/.zcode/automations/<id>.json，唯一写入点）
  → 手动触发回放（v1；cron 周期回放放后续增量）→ 回放报告（截图目录 + 状态 JSON）
```

- recording 文件是唯一事实源；回放状态只进报告文件，不回写 recording。

## 非目标（v1 边界）

- 不做桌面级 CUA 操作录制（zcode-cua 开源侧为占位实现，CUA 回放放 v2）。
- 不做录制步骤编辑器；v1 只能整体回放或删除。
- 不做跨设备同步录制件。
- v1 不实现浏览器交互的实时采集（用户操作 → 步骤流）；录制件先经服务面 `save`
  落库，采集接线（browser-use 插件录制事件 → AutomationRecording）放后续增量。
- v1 回放触发仅手动（UI 按钮）；cron 周期回放复用 automation 调度放后续增量。

## 验收场景

1. 录制一轮网页操作（打开页→点击→填表→提交）→ 保存为 automation → Bots 里手动触发
   回放成功并产出带截图的报告。
2. 回放中目标页面结构变化导致选择器失效 → 报告标记该步失败并附截图，不静默错乱。
3. 录制文件损坏时回放拒绝执行并提示，而非部分执行。

## 验证

- 回放引擎单测：固定步骤序列 + 本地测试页，断言逐步执行与失败策略。
- E2E：录制-保存-回放闭环（本地测试页）。
- `pnpm typecheck`；`pnpm architecture:check --changed`。
