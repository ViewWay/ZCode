# Spec：Smart 调度扩展 v3（任务类型感知路由）

在 Smart v2（套餐额度感知路由）之上增加任务复杂度/类型感知，对齐 MiMo Smart Router：简单任务走快模型，复杂任务升级旗舰；额度约束始终优先于升级诉求。

## 目标

1. Smart 虚拟选择（smart/auto）的路由决策从"额度感知"扩展为"额度 + 任务类型"双信号，简单任务走 flash 档，复杂任务升级 pro 档。
2. 分类 v1 规则式：不新增任何模型判别调用；模型判别作为后续可切换增强。
3. 路由决策对用户可见：档位切换有决策日志（note）与会话 UI 提示（当前模型 + 切换原因）。
4. 唯一路由入口：只扩展 SmartRoutingPort 宿主实现，不新建第二套路由面；v1 目录择优保持为回落层。

## 现状与增量

| 项         | 现状                                                                                                                                                                                                  | 增量                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| v1 路由    | `packages/provider/src/smart-routing.ts`：解析期目录择优（上下文窗口最大者优先，平手保持目录顺序）                                                                                                    | 不变；作为套餐耗尽时的回落层                                                 |
| v2 端口    | `apps/zcode-cli/packages/contracts/src/interfaces/smart-routing.port.ts`：`SmartRoutingPort.getRoutingDecision({ taskPreview })`，决策为 plan（tier: pro \| flash）/ catalog / unavailable，note 必带 | 宿主实现内扩展任务信号评估与决策表；端口契约不变（taskPreview 已是信号入口） |
| 额度层     | `packages/shared/src/usage-quota.ts`、`coding-plan-subscription.ts` 与 `packages/services/src/coding-plan-subscription`                                                                               | 只读消费，不改额度规则                                                       |
| automation | `packages/desktop/src/host/automationModelSelection.ts`：提交边界固定模型身份                                                                                                                         | 不变；automation 不参与逐轮路由                                              |
| UI         | Smart 选中时隐藏具体模型名与思考等级控件                                                                                                                                                              | 新增"当前模型 + 切换原因"提示（由决策 note 驱动）                            |

## 领域词汇

- **档位（tier）**：一次 Smart 路由的模型档——pro（复杂任务主力档）、flash（简单任务快档，免费轨优先）。
- **升级 / 降级**：相对上一轮档位的跳变；仅 flash→pro 为升级，pro→flash 为降级。
- **额度保护**：额度状态约束先于任务类型决策——降级优先于升级。

## 决策信号与决策表（草案）

信号全部规则式、逐轮计算、零新增模型调用：

```text
s1 输入规模   ：taskPreview 长度、代码块数、引用文件数
s2 会话阶段   ：会话内轮次；近几轮工具调用密度
s3 上下文规模 ：当前 context 长度档位
s4 额度状态   ：剩余额度 / 重置卡可用性（继承 v2）
```

决策表（自上而下，命中即停）：

```text
D1 套餐耗尽且无重置卡                          → catalog（回落 v1 目录择优）   ← 额度保护优先
D2 额度低 + flash 可用                         → plan/flash                    ← 降级优先于升级
D3 信号为复杂（多文件引用/长上下文/高工具密度）→ plan/pro（升级）
D4 信号为简单（短问答/单点修改）               → plan/flash
D5 信号中性或不确定                            → plan/pro（默认档，对齐 v2 现状）
```

- 阈值集中定义为命名常量（复杂度阈值、低额度阈值），不放散落字面量。
- 决策必须携带人话 note（对齐 v2 端口约定），供日志与会话 UI 消费。

## 状态所有者与数据流

```text
core turn（getRoutingDecision({ taskPreview })，契约不变）
  → SmartRoutingPort 宿主实现（bootstrap zcode-protocol 宿主，唯一路由所有者）
      ├─ 任务信号评估（v3 新增，纯函数、可独立单测）
      ├─ 决策表 → plan(tier, note) / catalog / unavailable
      └─ 额度读取（usage-quota / coding-plan-subscription，只读）
  → 决策 note → 会话事件 → UI「当前模型 + 切换原因」提示
```

- 信号评估是纯函数：输入 taskPreview / 会话统计 / 额度快照，输出信号集；决策表由宿主实现持有。
- core 侧零改动（端口缺席仍回落 v1）；UI 只消费决策 note，不自行推导档位。

## 权限与边界

- 决策日志：`info` 记录档位切换事件（升级/降级/回落），`debug` 记录逐轮信号与决策明细（高频，生产不落盘）。
- UI 提示是消息派生渲染，不新建持久化状态；广播同步不回写档位（防回环）。
- 端口实现方自行兜底：任何信号计算失败不得阻断 turn（对齐 v2 端口约定）。

## 非目标（v1 边界）

- 不做模型判别调用（零新增推理成本；模型判别作为可切换增强另评估）。
- 不做用户自定义路由规则 / 阈值设置页。
- 非 Smart 选择的会话不参与逐轮切换。
- automation 提交边界固定模型身份的语义不变。

## 验收场景

1. 同一会话：短问答走 flash；随后提出多文件重构请求升级 pro；会话 UI 显示切换原因，日志有对应 info 事件。
2. 套餐额度耗尽且无重置卡：回落目录择优（catalog），不因任务复杂而尝试升级。
3. 额度偏低时简单任务命中 D2 降级 flash，不出现"低额度还升级旗舰"的决策。

## 验证

- 决策表表驱动测试：信号组合 → 期望档位（覆盖 D1–D5 全分支与优先级冲突用例）。
- 真实额度边界用例：耗尽 / 低额度 / 重置卡三种额度状态下的决策断言。
- note 生成与日志事件断言；`pnpm typecheck`；`pnpm architecture:check --changed`。

## 待定项

1. 升级/降级阈值默认值（复杂度阈值、低额度阈值；上线前按实测校准）。
2. UI 提示形态：会话头部 badge 还是消息内联标记（对齐 DESIGN.md 后定）。
3. 模型判别增强是否复用 taskPreview 通道传入更多上下文。
4. s2/s3 信号（会话轮次/工具密度/上下文规模）：s2 轮次信号已接入（契约入参 turnIndex，阈值 6 轮，深会话走 pro）；s3 上下文规模需 turn 决策点的上下文长度信号，v3.1 接入；工具密度信号暂以输入规模启发覆盖。D1–D5 决策表已生效（含 D2 降级优先于升级、低额度不消耗重置卡）。
5. UI 透传面（已定）：切换档位时 Smart 决策（tier+note）随 ModelSelected 会话事件载荷的可选 smartRouting 字段透出（选型变化才发，天然只在换档时出现）；UI 消费面挂 v4 投影为后续增量——调查结论：renderer 无按名消费 model_selected 的处理器（模型信息经 v4 快照/行投影到达），且 `modelTrajectoryStore` 实为轨迹侧栏的打开桥接 store（无数据面），不作为透传目标。
