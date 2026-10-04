---
name: evolve
description: "Use when you want to modify ANY aspect of yourself — your capabilities (new tools via skills or MCP servers), your behavior (workspace hooks that intercept tool calls, prompts, sessions), your knowledge (skills and project memory that persist across sessions), or your orchestration (saved dynamic workflows). Nothing about you is fixed. Use proactively — the same manual sequence 3+ times, a repeated user correction, durable project knowledge, or any 'I wish I could...' moment is a trigger to evolve."
---

# Evolve — 自我改造（ZCode 层映射版）

> Adapted for ZCode from MiMo-Code's `evolve` skill (MIT)。原文的五层改写面已映射到
> ZCode 的真实扩展层：能力=技能/MCP；反射=workspace hooks；知识=技能+项目记忆；
> 编排=saved workflows；系统提示=AGENTS.md。**不引入 MiMo 的 `.mimocode/` 文件格式。**

你的每一层都可以通过写文件与调工具来改写：

- **你能做什么** —— 写一个 skill 封装新能力（Bash 流程/脚本），或接入一个 MCP server 增加原生工具
- **你如何反应** —— workspace hooks 拦截每次工具调用、prompt 提交、会话生命周期（七类事件）
- **你知道什么** —— skills 沉淀领域知识（三级发现：bundled/用户/插件），project memory 沉淀项目事实（召回注入）
- **你如何编排** —— saved workflows 把跑通的多智能体流水线固化为可恢复的运行图

本技能不是文档——它是**常驻指令：察觉该进化的时机，并动手**。

## 何时进化（触发信号，主动行动不要等用户开口）

| 信号 | 动作 |
|------|------|
| 同一 Bash/API 序列跑了 3+ 次（本会话或历史会话） | 封装为 **skill**（`~/.zcode/skills/<name>/SKILL.md`）或 **saved workflow** |
| 同一错误反复犯，或用户反复纠正同一行为 | 加一条 **PreToolUse / PostToolUseFailure hook** 结构性拦截或修正 |
| 学到未来会话需要的非显性项目知识 | 写 **project memory**（A6 审阅确认后）或 **skill** 持久化 |
| 内置工具行为与项目需求冲突 | 用 **hook** 在该事件上拦截/改写（需过信任审阅） |
| 手工编排跑通的多智能体流水线可能复用 | **CreateWorkflow → SaveWorkflow** 固化为运行图 |
| 项目级约定缺失导致每次都要口头交代 | 补 **AGENTS.md / .zcode/config.json** 指令层 |

创建前先查重：`ls ~/.zcode/skills`、查看 saved workflows 列表、读既有 hook 配置——优先改进既有扩展，不收近似重复品。

## 决策流

```
要改「能做什么」 → skill（封装流程）或 MCP server（新原生工具，配置接入）
要改「如何反应」 → workspace hook（PreToolUse/PostToolUse/Stop 等七事件拦截）
要记住「怎么做 X」 → skill（按需加载的知识）
要重跑「多智能体流水线」 → saved workflow（dwf 可恢复运行图）
要改「系统级行为约定」 → AGENTS.md / .zcode/config.json 指令层
```

经验法则：skill 加记忆，hook 加反射，workflow 加编排，AGENTS.md 加约定。

## 各层落地要领

### Skill（知识/能力封装）

```markdown
---
name: <kebab-name>
description: "一句话触发描述（模型按此决定何时加载）"
---

# 标题
正文：流程、命令、注意事项
```

放 `~/.zcode/skills/<name>/SKILL.md`（用户级，三级发现自动注入）；用户说"保存成技能"即代写此文件。重复 3+ 次的序列在写技能前先跑一遍确认是稳定流程。

### Workspace Hook（行为反射）

配置在 `zcode.json` / `.zcode/config.json`（写入后需过信任审阅准入）：

```json
{
  "hooks": {
    "PostToolUseFailure": [
      { "matcher": "Bash", "command": ".zcode/hooks/notify-failure.sh" }
    ]
  }
}
```

七类事件：SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure / Stop。hook 命令收 stdin（JSON 事件），退出码非零可拦截。

### Saved Workflow（编排）

跑通的流水线：CreateWorkflow（脚本图）→ 试运行 → SaveWorkflow 落库（可 ResumeWorkflowRun 恢复）。脚本内用 submit_result 提交结构化结果。

### Project Memory（项目事实）

写 `<memoryRoot>/` 下的记忆 Markdown（frontmatter 带 description，与召回格式一致）。经 A6 审阅确认的候选由服务代写；直接写入必须走 memory agent 同一格式，不建第二格式。

### AGENTS.md（项目约定）

每次口头交代超过一次的项目约定（命名/测试/提交流程），提议写入项目 AGENTS.md——一次写入，之后每个会话自动生效。

