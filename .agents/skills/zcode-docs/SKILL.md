---
name: zcode-docs
description: Use when finishing a behavior change in this repo (or asked to sync docs) — sweep the owning spec, AGENTS.md command table, CONTEXT.md vocabulary, module CONTRACT.md, README and i18n for stale content, and update the owning doc before finishing. Keep repository self-documentation in sync with the checked-out source.
---

# ZCode 自我文档技能

仓库契约：**文档与当前检出源码一致**（AGENTS.md 核心原则）。本技能是收尾纪律：行为改动后，按改动面同步对应文档，不凭记忆写文档，先核对当前源码。

## 何时用

- 某个行为改动收尾时（新增/修改/删除能力、命令、接口、协议字段）。
- 发现文档与源码不一致（命令表、文件列表、词汇与实现漂移）。

## 同步对象与判定

| 改动面             | 同步对象                                            | 判定方式                                                                                |
| ------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 产品行为/协议/接口 | `specs/<领域>.md`（行为契约、状态所有者、验收场景） | 规格是行为的唯一契约面；先改 spec 再改代码（AGENTS.md）                                 |
| 仓库命令/包结构    | `AGENTS.md` 命令表与仓库结构清单                    | 逐条对照根 `package.json` 与包 `package.json`；说明中只保留当前仓库实际提供的命令与文件 |
| 插件商店 UI 词汇   | `CONTEXT.md`                                        | 改插件商店相关 UI 前后核对                                                              |
| 模块公共面         | 模块 `CONTRACT.md`（如有）                          | 与架构治理技能的受控上下文一致                                                          |
| 面向用户的入口     | `README` / i18n locales                             | 与实际入口、实际 locale key 对齐                                                        |

## 流程

1. 定位唯一所属文档：一份行为只归一份权威文档；发现双头文档先收敛再更新。
2. 先 spec 后代码回查：行为已改但 spec 未回写时，先回写 spec（含状态所有者、事件顺序、幂等边界、验收场景）。
3. 删除能力时反向清理：同步删除指令、技能与文档中的引用（含包 README 与技能文件）。
4. 只写当前检出的真实命令与文件；不确定时跑 `node scripts/check-workspace-freshness.mjs` 与目标包 `package.json` 核对，不引用记忆中的旧命令。
5. 收尾核对：行为改动没有对应 spec/文档更新不算完成；文档更新随行为提交同 PR，不单独漂移。

## 边界

- 不在文档中写入凭据、真实用户数据或内部服务地址（AGENTS.md 日志红线）。
- 不为未实现的想法写“已支持”；待定项写进 spec 待定项小节，明确判定条件。
