// 成员模型路由单测：Agent 工具 model 入参（"providerId/modelId"）→ spawnTeammate
// 请求 → runner runExploreAgent 运行时请求的透传链，外加 TeamPlan launchPlan 对
// member.model 的回灌与标签解析边界。
// 运行：cd apps/zcode-cli/packages/core && node_modules/.bin/tsx --test test/team/teammate-model-routing.test.ts

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  parseTeammateModelLabel,
  type SubagentPort,
  type SubagentTeammateSpawnRequest,
  type TeammateLaunchedOutput,
  type TraceContext,
} from "@zcode/contracts";
import { createExploreSubagentPort } from "../../src/subagent/runner.js";
import { agentToolEntry } from "../../src/tool/handlers/agent.js";
import { formatLaunchPlan } from "../../src/tool/handlers/team-plan.js";
import type { ToolExecutionContext } from "../../src/tool/types.js";

function teammateHandlerContext(port: Partial<SubagentPort>): ToolExecutionContext {
  return {
    toolCallId: "call_model_route",
    traceId: "trace_model_route" as ToolExecutionContext["traceId"],
    abortSignal: new AbortController().signal,
    workspaceRoot: "/workspaces/demo",
    workingDirectory: "/workspaces/demo",
    sessionId: "sess_model_route",
    subagentPort: port,
  } as ToolExecutionContext;
}

const TEAMMATE_LAUNCHED = {
  status: "teammate_launched",
  isAsync: true,
  agentId: "agent_model_1",
  agentType: "general-purpose",
  description: "spawn member",
  prompt: "work",
  childSessionId: "child_model_1",
  backgroundTaskId: "agent_model_1",
  teamName: "model-team",
  teammateName: "alice",
  outputFile: "/tmp/zcode-agents/model-route/output.txt",
  canReadOutputFile: false,
} as const satisfies TeammateLaunchedOutput;

test("agent handler: teammate 路径把 model 透传进 spawnTeammate 请求", async () => {
  const spawns: SubagentTeammateSpawnRequest[] = [];
  const port: Partial<SubagentPort> = {
    spawnTeammate: async (request) => {
      spawns.push(request);
      return TEAMMATE_LAUNCHED;
    },
  };
  const context = teammateHandlerContext(port);

  await agentToolEntry.handler(
    {
      description: "spawn member",
      prompt: "work",
      team_name: "model-team",
      name: "alice",
      model: "anthropic/claude-haiku-4-5",
    },
    context,
  );
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]?.model, "anthropic/claude-haiku-4-5");

  // model 缺失：请求不携带 model 字段，与现状一致。
  await agentToolEntry.handler(
    { description: "spawn member", prompt: "work", team_name: "model-team", name: "bob" },
    context,
  );
  assert.equal(spawns.length, 2);
  assert.equal("model" in (spawns[1] ?? {}), false);

  // model 在场但解析不出 provider/model：teammate 路径按无效入参拒绝，不静默丢模型。
  await assert.rejects(
    agentToolEntry.handler(
      {
        description: "spawn member",
        prompt: "work",
        team_name: "model-team",
        name: "carol",
        model: "haiku",
      },
      context,
    ),
    /providerId\/modelId/,
  );
  assert.equal(spawns.length, 2);
});

test("runner: request.model 穿线到 runExploreAgent 的运行时请求", async () => {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-model-route-"));
  after(async () => {
    await rm(outputRootDir, { recursive: true, force: true });
  });
  const runtimeRequests: (Record<string, unknown> | undefined)[] = [];
  const port = createExploreSubagentPort({
    outputRootDir,
    runExploreAgent: async (request) => {
      runtimeRequests.push(request as unknown as Record<string, unknown>);
      return { response: "done", events: [], traceId: "trace_model_route" };
    },
    emitParentEvent: async () => {},
    enqueueParentTaskNotification: () => undefined,
  });
  const trace = {
    traceId: "trace_model_route",
    spanId: "span_model_route",
    sessionId: "sess_model_route",
  } as TraceContext;
  const baseRequest = {
    sessionId: "sess_model_route",
    turnId: "turn_model_route",
    parentToolCallId: "call_model_route",
    agentType: "general-purpose",
    description: "route model",
    prompt: "work",
    workingDirectory: "/workspaces/demo",
    workspaceRoot: "/workspaces/demo",
    trace,
  };

  await port.run({ ...baseRequest, model: "openrouter/qwen/qwen3-coder" });
  assert.equal(runtimeRequests[0]?.model, "openrouter/qwen/qwen3-coder");

  // model 缺失：运行时请求不带 model 字段（行为不变）。
  await port.run(baseRequest);
  assert.equal("model" in (runtimeRequests[1] ?? {}), false);
});

test("team plan launchPlan: member.model 回灌进 Agent spawn 剧本", () => {
  const lines = formatLaunchPlan({
    schemaVersion: 1,
    teamName: "plan-model",
    sessionId: "sess_model_route",
    revision: 3,
    state: "approved",
    members: [
      {
        id: "be",
        name: "backend",
        prompt: "You own the storage layer",
        model: "anthropic/claude-haiku-4-5",
      },
      { id: "fe", name: "frontend", prompt: "You own the UI" },
    ],
    tasks: [],
    approvedAt: "2026-10-01T00:00:00.000Z",
  });
  const backendLine = lines.find((line) => line.includes("backend")) ?? "";
  assert.match(backendLine, /\(model: anthropic\/claude-haiku-4-5\)/);
  const frontendLine = lines.find((line) => line.includes("frontend")) ?? "";
  assert.equal(frontendLine.includes("model:"), false);
});

test("parseTeammateModelLabel: 首个 / 拆分；缺席/空白/无分隔符返回 undefined", () => {
  assert.deepEqual(parseTeammateModelLabel("anthropic/claude-haiku-4-5"), {
    providerId: "anthropic",
    modelId: "claude-haiku-4-5",
  });
  // modelId 自身可含 /（首个 / 是 provider 边界，如 openrouter/<org>/<model>）。
  assert.deepEqual(parseTeammateModelLabel("openrouter/qwen/qwen3-coder"), {
    providerId: "openrouter",
    modelId: "qwen/qwen3-coder",
  });
  assert.equal(parseTeammateModelLabel(undefined), undefined);
  assert.equal(parseTeammateModelLabel("  "), undefined);
  assert.equal(parseTeammateModelLabel("haiku"), undefined);
  assert.equal(parseTeammateModelLabel("/model"), undefined);
  assert.equal(parseTeammateModelLabel("provider/"), undefined);
});
