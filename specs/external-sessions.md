# Spec：外部会话只读互操作（Claude Code transcripts）

对齐 MiMo 的 `list_external_sessions` / `read_external_session`（其 asar 内
`claude-code-session-worker` 承担同职能）：让 ZCode 能发现并只读访问本机 Claude Code
的历史会话。

## 目标

1. 新增只读工具：`list_external_sessions`（列元数据）与 `read_external_session`
   （读单会话内容）。
2. 数据源为本机 Claude Code 的 transcript JSONL（`~/.claude/projects/<项目目录slug>/*.jsonl`），
   解析器对未知行容错跳过。
3. 严格只读：任何情况下不写 Claude Code 目录，不删除、不迁移其数据。
4. 外部会话在列表中带 `external` 标注，与本地存活会话不混排。

## 现状与增量

| 项 | 现状 | 增量 |
| --- | --- | --- |
| core | 无外部会话概念；`session-chat.ts` 只覆盖本仓存活会话 | 新增 external-session 工具组与 JSONL 解析器 |
| 路径边界 | 外部路径默认触发授权 | `~/.claude/projects` 列入工具内部白名单（仅读），其余外部路径仍走授权 |
| 插件 | `restore-legacy-sessions-plugin` 负责旧版会话导入 | 本 spec 只做**读取**；导入/迁移仍归该插件，不重叠 |
| 声明 | `NOTICE.md` | 补条目：纯本地读取，无外发；描述中包含隐私警示 |

## 工具契约（草案）

```text
list_external_sessions:
  input : { project_path?: 本机项目绝对路径 }
  output: { sessions: [{ id, title?, project_path, mtime, message_count }] }

read_external_session:
  input : { id }
  output: { messages: [{ role, content, timestamp? }], warnings?: string[] }
  约束  : 解析失败的行跳过并在 warnings 计数，不中断读取
```

- 工具描述必须包含警示（对齐 MiMo 原文语义）：transcript 可能含敏感路径、参数与
  凭据，内容由模型自行判断是否引用。

## 解析器设计

- 位置：`apps/zcode-cli/packages/core/src/external-sessions/`（新目录，与 tool 解耦）。
- 每行一个 JSON 对象；未知 `type` 字段跳过；时间戳缺失允许为空。
- 目录 slug 规则（路径→目录名替换 `/`、`.` 等）以实测 Claude Code 版本为准；解析器
  以「枚举目录 + 逐行解析」为主，不依赖 slug 反推。

## 状态所有者与数据流

```text
list/read 工具（core handler）
  → external-sessions 解析器（core，只读 ~/.claude/projects）
  → 结构化消息数组 → 模型上下文
```

无持久化状态：不缓存、不建索引（v1）；每次调用实时读盘。

## 非目标（v1 边界）

- 不做写入/删除/迁移 Claude Code 数据。
- 不做外部会话与本仓会话的合并、搜索索引。
- 外部会话是否纳入 session-chat 联系人面（带 external 标注）为**待定项**——倾向 v1
  只做独立只读工具，联系人集成放 v2。

## 验收场景

1. 在装有 Claude Code 的机器上，模型能列出历史会话并读取内容，实现"继续上次的工作"。
2. 无 `~/.claude/projects` 目录时返回空列表，不报错。
3. 含损坏行的 JSONL 能跳过坏行继续读取。

## 验证

- 用脱敏的固定 JSONL 样本做解析测试（正常行/未知行/损坏行三类）。
- 路径边界测试：白名单外路径不因本工具放行。
- `pnpm typecheck`；`pnpm architecture:check --changed`。
