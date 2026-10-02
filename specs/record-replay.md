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

## 数据模型（草案）

```text
AutomationRecording:
  id, created_at (ISO 8601), source: "browser" | "cua"（v1 仅 browser）
  steps: [{ seq, action: navigate|click|type|wait|scroll|extract,
            target?: selector|坐标, value?, screenshot?: 路径 }]
```

- 存储位置：`~/.zcode/automations/`（与 `~/.zcode/v2/bot-config.v3.json` 同级但不混用
  Bots 配置文件，仅通过 scheduler 协议交互）。
- 回放引擎逐步执行；某步失败默认截图 + 中断，可配置为跳过继续。

## 状态所有者与数据流

```text
浏览器会话（browser-use 插件）→ 录制采集（新增，host 层）
  → AutomationRecording（~/.zcode/automations/<id>.json，唯一写入点）
  → scheduler 调度回放 → 回放报告（截图目录 + 状态 JSON）
```

- recording 文件是唯一事实源；回放状态只进报告文件，不回写 recording。

## 非目标（v1 边界）

- 不做桌面级 CUA 操作录制（zcode-cua 开源侧为占位实现，CUA 回放放 v2）。
- 不做录制步骤编辑器；v1 只能整体回放或删除。
- 不做跨设备同步录制件。

## 验收场景

1. 录制一轮网页操作（打开页→点击→填表→提交）→ 保存为 automation → Bots 里手动触发
   回放成功并产出带截图的报告。
2. 回放中目标页面结构变化导致选择器失效 → 报告标记该步失败并附截图，不静默错乱。
3. 录制文件损坏时回放拒绝执行并提示，而非部分执行。

## 验证

- 回放引擎单测：固定步骤序列 + 本地测试页，断言逐步执行与失败策略。
- E2E：录制-保存-回放闭环（本地测试页）。
- `pnpm typecheck`；`pnpm architecture:check --changed`。
