# Spec：自动沉淀（auto-distill，evolve 的最薄层）

MiMo 的 evolve（`evolve-seed` 仿生大脑）是完整自进化系统；本 spec 只做**可验证薄层**：
把近期会话中的可复用知识自动沉淀为项目记忆候选，经确认后复用。完整自进化另立 spec。

## 目标

1. 会话结束后，后台任务从近期会话提取"可复用结论"生成候选。
2. 候选经用户在设置页审阅确认后写入项目记忆，并在后续会话注入。
3. 全程复用现有 memory 子系统的读写路径，不建第二写入路径。

## 现状与增量

| 项     | 现状                                                       | 增量                                                                      |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| memory | `packages/services/src/memory` + core 侧 memory 提取已存在 | 增加候选（pending）状态与审阅入口；提取触发从"会话内"扩展到"会话结束后台" |
| UI     | 无知识审阅界面                                             | 设置页新增"已沉淀知识"审阅列表（确认/删除/提升为技能草稿）                |
| 触发   | 提取依赖会话内模型调用                                     | 已接入会话结束触发器（CLI bootstrap 会话收口，见下）                      |

## v1 接线现状

- **触发器**：`apps/zcode-cli/packages/bootstrap/src/app/distill-close-trigger.ts`，挂在
  session-facade `close()` 中、session store 关闭之前；durable messages 映射为提取输入
  （真实用户输入与 assistant 可见 text 片段 + Bash `input.command` 行内片段），失败只记
  日志不影响会话结束（验收场景 3）。同会话进程内频控只触发一次。远程 workspace 不触发
  （确认动作在本地 host 落项目记忆，远程记忆目录不在本地）。
- **候选存储**：唯一实现在 `packages/shared/src/node/auto-distill/candidateStore.ts`
  （`@zcode/shared/node`），CLI 触发器与 Desktop 审阅面共用；类型在 `@zcode/shared` 根
  （renderer 可用）。
- **审阅数据面**：`IDistillKnowledgeService`（`packages/services/src/auto-distill/`，channel
  `distill-knowledge`）四件套——services 服务面 + client 代理 + Desktop 本地 Host 注册 +
  UI 卡（`packages/ui/src/settings/DistillKnowledgeCard.tsx`，挂「自动化」页 scheduled 页签）。
- **确认的 memory 写入桥**：core memory agent 是 turn 内模型驱动（宿主无触发 RPC 面），
  候选确认是确定性内容——直接写 core memory agent 同一项目记忆目录
  （`resolveProjectMemoryRoot` 同源公式，shared/node 唯一实现），产出 recall 可读条目
  （frontmatter description + metadata.node_type/originSessionId/type=project）；候选按
  `workspace` 字段（触发器写入）定位目录；写失败补偿回候选列表。
- **提升**：SKILL.md 草稿落用户技能根目录（`~/.zcode/skills`），不启用。

## 领域词汇

- **候选（candidate）**：从会话提取、尚未确认的知识条目，含来源会话 id、置信度、摘要。
- **沉淀**：候选被确认后写入 memory，成为正式记忆条目。
- **提升**：把高置信候选转成 SKILL.md 草稿（bundled-skills 目录结构）。

## 状态所有者与数据流

```text
会话结束事件（desktop host）→ 提取任务（v1 规则式，模型提取为可切换实现）
  → 候选存储（~/.zcode/distill/candidates.json，唯一写入点）
  → 设置页审阅（确认/删除）→ 写入 memory（services/memory 既有路径）
  → 后续会话注入（既有召回链路）
```

- candidates.json 是候选的唯一事实源；确认后数据所有权移交 memory，候选记录删除。
- 不做跨设备同步（v1）。

## 设计要点

- 提取 v1 用规则式（重复出现的命令序列、被用户采纳的修复模式），模型提取作为可选
  实现开关；规则式保证离线可验证。
- 每候选必带来源会话 id 与置信度；审阅列表按置信度排序。
- "提升为技能草稿"生成 SKILL.md 骨架（frontmatter + 正文骨架），产出物进入用户技能
  目录候选位，不直接启用。

## 非目标（v1 边界）

- 不做主循环自我修改（evolve 的"进化"层）。
- 不做跨项目知识迁移。
- 不做静默自动写入 memory（必须经审阅确认）。

## 验收场景

1. 连续若干会话后，审阅列表出现高置信候选；确认后的知识在后续会话可被召回。
2. 删除候选不产生 memory 写入；确认候选产生恰好一条 memory 条目（幂等）。
3. 提取任务失败不影响会话正常结束。

## 验证

- 提取规则的真实链路测试（固定会话样本→候选）；memory 写入幂等测试。
- UI 审阅列表交互改动补 E2E 场景。
- `pnpm typecheck`；`pnpm architecture:check --changed`。
