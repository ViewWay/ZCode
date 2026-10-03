---
name: "memory-search"
description: "Structured analysis over ZCode's model-io trajectory files: per-model call/token aggregates, tool invocation counts, error hotspots, cross-session patterns, and execution chains for one session. Use when built-in text search is insufficient — e.g. 'which tool fails most', 'token spend by model', or 'show the execution chain of session S'. Read-only over ~/.zcode/cli/{debug,rollout}/model-io-<sessionId>.jsonl."
---

# Memory Search（ZCode 版）：model-io 轨迹结构化分析

对齐 mimocode memory-search 的理念（聚合/结构化过滤/跨会话模式），但数据源是
**ZCode 自己的 model-io JSONL**（`~/.zcode/cli/{debug,rollout}/model-io-<sessionId>.jsonl`，
一个 session 一个文件；记录 `type:"model_io"`）。本文件给模型可直接使用的查询配方。

## 路径一（今日可用）：jq 直查（Bash）

记录为 JSONL（每行一个 model_io 对象）。常用配方：

```bash
# 按模型聚合调用数与 token
jq -s '[.[] | select(.type=="model_io")] |
  group_by(.model.modelId) |
  map({model: .[0].model.modelId, calls: length,
       tokens: (map(.response.usage.totalTokens // 0) | add)})' \
  ~/.zcode/cli/rollout/model-io-*.jsonl

# 按工具统计调用轮次（request.toolNames 出现即计一次）
jq -s '[.[] | select(.type=="model_io") | .request.toolNames[]?] |
  group_by(.) | map({tool: .[0], calls: length}) | sort_by(-.calls)' \
  ~/.zcode/cli/rollout/model-io-*.jsonl

# 错误热点：带 error 的模型调用
jq -c 'select(.type=="model_io" and .error)' ~/.zcode/cli/rollout/model-io-*.jsonl
```

## 路径二（桌面服务面，供 UI/后续工具化）

宿主任务服务提供 `getTrajectoryUsageStats({ sinceMs?, maxSessions? })` 聚合与
`getModelTrajectory({ taskId })` 单会话执行链（模型侧工具化在路线图上；当前从
UI 轨迹侧栏消费）。

## 路径三：单会话执行链

按行顺序即调用顺序；每行含 `turnId`、`model.modelId`、`response.toolCalls`（名称与
参数摘要）、`response.usage`。追问"session S 都做了什么"时按行 summarize。

## 边界

- 只读；不建索引不落库（每次现扫，文件多时先按 sinceMs/maxSessions 收窄）。
- 工具级失败判定（哪个工具结果失败）需要 toolResults 配对分析，v1 未做——当前
  `error` 是模型调用级错误。
