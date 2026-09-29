# FlowPilot × agent-teams 集成规格（v2.8）

## 定位

FlowPilot 管**流程与质量**（目标澄清、任务计划、AC 验收标准、确定性提示词引擎、验证报告）；agent-teams 管**团队与执行**（持久命名成员、worktree 隔离、共享任务板、依赖调度、完成通知、验收-返工环、知识沉淀）。集成后：**FlowPilot 出计划与验收，agent-teams 出团队与执行**。

## 职责与事实源边界

| 域 | 事实源 | 说明 |
|---|---|---|
| 目标/任务计划/AC 标准/验证证据 | FlowPilot `.flow/` | AC 判定链路（标准→任务→证据→判定）归 FlowPilot，机器可校验 |
| 团队/成员/团队任务认领态/收件箱 | agent-teams（~/.zcode/teams/<key>/）| TeamTask 以 externalId 引用 FlowPilot task_id 对账 |
| 成员工作副本 | git worktree（分支 zcode/<team>/<member>）| 完成由 lead 按分支合并；TeamDelete 清目录留分支 |
| 知识沉淀 | 团队 knowledge/ → 归档 + Promote 到 ~/.zcode/skills | 跨项目复用 |

## 派发模式

flowpilot-execute 的 dispatch 键新增 **team** 模式（完整循环见 flowpilot-execute SKILL.md「团队派发循环」节）：

1. 建队一次：TeamCreate({name, useWorktree: true}) + 按角色 Agent spawn 常驻成员。
2. 任务映射：TaskCreate({subject: "<title> [flow:<task_id>]", blockedBy, externalId: task_id})——[flow:] 尾注与 externalId 双锚对账。
3. 派发：task_prompt 组装提示词 → SendMessage 下发给按 task.role 匹配的成员（无匹配 → 空闲自动认领/lead 指派）。
4. 完成通知 → lead 按 AC 验收（mechanical 自执行命令 / llm 派独立判定子代理）→ done；未过 → 意见 SendMessage 回 owner 返工（原 worktree 上下文不丢）。
5. /flow:finish → TeamDelete（worktree 分支保留合并、知识归档）。

## agent-teams 内核增量

- TeamTask.externalId（TaskCreate/TaskUpdate 可设，输出返回）：编排层对账锚点。
- 其余复用既有能力：blockedBy/ready、自动认领、完成通知、验收 verdict、自通知过滤、通知聚合。

## FlowPilot 侧变更

- flowpilot-execute SKILL.md：dispatch 枚举 +「团队派发循环」节（纯技能文本，零 server 代码改动）。
- 生效需 repack：node build/pack.mjs 同步 adapters 分发产物。

## 实战流程建议

1. 选定目标项目 → /flow:start 澄清目标与 AC。
2. /flow:config set dispatch=team → /flow:next 逐任务团队派发。
3. lead 按 AC 验收；revise 意见自动回成员返工。
4. /flow:finish 出验证报告 → 合并成员分支 → TeamDelete（知识归档）。
