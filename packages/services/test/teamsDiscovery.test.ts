// Agent Teams 只读发现服务单测（specs/agent-teams.md：services 只读投影、身份键隔离、
// 与 runtime team-paths.ts 的目录兼容性）。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test packages/services/test/teamsDiscovery.test.ts

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createTeamsService } from "../src/teams/teamsDiscoveryService.js";
import {
  resolveTeamsIdentityKey,
  resolveTeamsWorkspaceDir,
  resolveTeamsWorkspaceKey,
} from "../src/teams/teamsPaths.js";

let homeDir: string;
let cleanup: () => Promise<void>;

before(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "zcode-teams-discovery-"));
  cleanup = () => rm(homeDir, { recursive: true, force: true });
});

after(async () => {
  await cleanup();
});

function dirs() {
  return { homeDirResolver: () => homeDir };
}

test("workspace-key hashing matches the runtime team-paths algorithm (pinned vectors)", () => {
  // 样例向量由 sha256(key) 前 12 位 hex 钉死：runtime 与 services 分属两个
  // workspace 无法共享代码，向量漂移即意味着 roster 会静默指向空目录。
  assert.equal(resolveTeamsWorkspaceKey("/workspaces/demo"), "9f9911450ab6");
  assert.equal(resolveTeamsWorkspaceKey("remote://abc123"), "7917953d00a8");
  // 身份归一：identity 优先、路径兜底、identity 空白串视为未设置。
  assert.equal(resolveTeamsIdentityKey({ workspaceIdentity: "  ", workspacePath: "/w" }), "/w");
  assert.equal(
    resolveTeamsIdentityKey({ workspaceIdentity: "ws-identity", workspacePath: "/w" }),
    "ws-identity",
  );
});

test("list returns empty for a workspace without teams", async () => {
  const service = createTeamsService(dirs());
  const result = await service.list({ workspacePath: "/workspaces/empty" });
  assert.deepEqual(result, { teams: [] });
});

test("list projects team rosters and skips unreadable configs", async () => {
  const wsDir = resolveTeamsWorkspaceDir({ workspacePath: "/workspaces/demo" }, dirs().homeDirResolver);
  const good = join(wsDir, "alpha");
  const bad = join(wsDir, "broken");
  await mkdir(join(good, "inboxes"), { recursive: true });
  await mkdir(bad, { recursive: true });
  await writeFile(
    join(good, "config.json"),
    JSON.stringify({
      name: "alpha",
      description: "demo team",
      leadAgentId: "lead_s1",
      createdAt: "2026-09-25T00:00:00.000Z",
      members: [
        { agentId: "lead_s1", name: "team_lead", isActive: true, joinedAt: "2026-09-25T00:00:00.000Z" },
        { agentId: "agent_alice", name: "alice", isActive: false, color: "blue" },
        // 缺关键字段的成员被丢弃，不拖垮整个团队。
        { name: "ghost" },
      ],
    }),
    "utf8",
  );
  await writeFile(join(bad, "config.json"), "{ not json", "utf8");

  const service = createTeamsService(dirs());
  const result = await service.list({ workspacePath: "/workspaces/demo" });
  assert.equal(result.teams.length, 1);
  const team = result.teams[0]!;
  assert.equal(team.name, "alpha");
  assert.equal(team.leadAgentId, "lead_s1");
  assert.equal(team.members.length, 2);
  assert.equal(team.members[0]!.isActive, true);
  assert.equal(team.members[1]!.color, "blue");
});

test("workspaces with distinct identity keys do not see each other's teams", async () => {
  const service = createTeamsService(dirs());
  const result = await service.list({ workspacePath: "/workspaces/other" });
  assert.deepEqual(result, { teams: [] });
});

test("listInboxMessages projects member inbox messages and tolerates missing files (v2.9)", async () => {
  const service = createTeamsService(dirs());
  const inboxDir = join(homeDir, ".zcode", "teams", resolveTeamsWorkspaceKey("/workspaces/demo"), "alpha", "inboxes");
  await mkdir(inboxDir, { recursive: true });
  await writeFile(
    join(inboxDir, "alice.json"),
    JSON.stringify([
      { id: "m1", from: "team_lead", to: "alice", payload: { kind: "text", text: "do it" }, sentAt: new Date().toISOString(), read: true },
      { id: "m2", from: "alice", to: "team_lead", summary: "done", payload: { kind: "task_notification", taskId: "task_1", subject: "X", status: "completed", actor: "alice" }, sentAt: new Date().toISOString(), read: false },
    ]),
    "utf8",
  );
  const result = await service.listInboxMessages({ workspacePath: "/workspaces/demo", teamName: "alpha", memberName: "alice" });
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].payloadKind, "text");
  assert.equal(result.messages[0].text, "do it");
  assert.equal(result.messages[1].payloadKind, "task_notification");
  assert.equal(result.messages[1].status, "completed");

  // 收件箱不存在的成员容忍返回空
  const missing = await service.listInboxMessages({ workspacePath: "/workspaces/demo", teamName: "alpha", memberName: "nobody" });
  assert.deepEqual(missing.messages, []);
});

test("listTasks projects tasks.json and tolerates missing/corrupt files", async () => {
  const service = createTeamsService(dirs());
  const teamDir = join(homeDir, ".zcode", "teams", resolveTeamsWorkspaceKey("/workspaces/demo"), "delta");
  await mkdir(join(teamDir, "inboxes"), { recursive: true });
  await writeFile(
    join(teamDir, "tasks.json"),
    JSON.stringify({
      teamName: "delta",
      tasks: [
        { taskId: "task_1", subject: "设计 API", status: "completed", owner: "alice", version: 3, createdAt: "2026-09-25T00:00:00.000Z", updatedAt: "2026-09-25T01:00:00.000Z" },
        { taskId: "task_2", subject: "实现 API", status: "pending", version: 0, blockedBy: ["task_1"], externalId: "FP-7", createdAt: "2026-09-25T00:00:00.000Z", updatedAt: "2026-09-25T01:00:00.000Z" },
        { subject: "缺关键字段的任务" },
      ],
    }),
    "utf8",
  );
  const result = await service.listTasks({ workspacePath: "/workspaces/demo", teamName: "delta" });
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0]!.owner, "alice");
  assert.equal(result.tasks[0]!.version, 3);
  assert.deepEqual(result.tasks[1]!.blockedBy, ["task_1"]);
  assert.equal(result.tasks[1]!.externalId, "FP-7");

  await writeFile(join(teamDir, "tasks.json"), "{ not json", "utf8");
  const corrupt = await service.listTasks({ workspacePath: "/workspaces/demo", teamName: "delta" });
  assert.deepEqual(corrupt.tasks, []);

  const missing = await service.listTasks({ workspacePath: "/workspaces/demo", teamName: "ghost" });
  assert.deepEqual(missing.tasks, []);
});

test("getDashboard aggregates roster, tasks, merged inbox and plan", async () => {
  const service = createTeamsService(dirs());
  const teamDir = join(homeDir, ".zcode", "teams", resolveTeamsWorkspaceKey("/workspaces/demo"), "bravo");
  await mkdir(join(teamDir, "inboxes"), { recursive: true });
  await writeFile(
    join(teamDir, "config.json"),
    JSON.stringify({
      name: "bravo",
      leadAgentId: "lead_s1",
      members: [
        { agentId: "lead_s1", name: "team_lead", isActive: true },
        { agentId: "agent_alice", name: "alice", isActive: true, color: "blue" },
        { agentId: "agent_bob", name: "bob", isActive: false, color: "green" },
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(teamDir, "tasks.json"),
    JSON.stringify({
      teamName: "bravo",
      tasks: [
        { taskId: "task_1", subject: "调研", status: "completed", owner: "alice", version: 2, createdAt: "2026-09-25T00:00:00.000Z", updatedAt: "2026-09-25T01:00:00.000Z" },
        { taskId: "task_2", subject: "落地", status: "pending", version: 0, blockedBy: ["task_1"], createdAt: "2026-09-25T00:00:00.000Z", updatedAt: "2026-09-25T01:00:00.000Z" },
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(teamDir, "inboxes", "alice.json"),
    JSON.stringify([
      { id: "m-old", from: "team_lead", to: "alice", summary: "先做调研", payload: { kind: "text", text: "先做调研" }, sentAt: "2026-09-25T01:00:00.000Z", read: true },
    ]),
    "utf8",
  );
  await writeFile(
    join(teamDir, "inboxes", "bob.json"),
    JSON.stringify([
      { id: "m-new", from: "alice", to: "bob", summary: "调研完成", payload: { kind: "task_notification", taskId: "task_1", subject: "调研", status: "completed", actor: "alice" }, sentAt: "2026-09-25T02:00:00.000Z", read: false },
    ]),
    "utf8",
  );
  await writeFile(
    join(teamDir, "plan.json"),
    JSON.stringify({
      schemaVersion: 1,
      teamName: "bravo",
      sessionId: "s1",
      revision: 1,
      state: "review_pending",
      members: [{ id: "m1", name: "alice", prompt: "做调研", reason: "熟悉领域", difficulty: "low" }],
      tasks: [{ id: "pt1", subject: "调研", owner: "alice", depends: [] }],
    }),
    "utf8",
  );

  const dashboard = await service.getDashboard({ workspacePath: "/workspaces/demo", teamName: "bravo" });
  assert.equal(dashboard.team.name, "bravo");
  assert.equal(dashboard.team.members.length, 3);
  assert.equal(dashboard.tasks.length, 2);
  assert.equal(dashboard.messages.length, 2);
  assert.equal(dashboard.messages[0]!.id, "m-new");
  assert.equal(dashboard.plan?.state, "review_pending");
  assert.equal(dashboard.plan?.members[0]!.name, "alice");
  assert.equal(dashboard.plan?.tasks[0]!.depends.length, 0);

  await writeFile(join(teamDir, "plan.json"), "{ not json", "utf8");
  const noPlan = await service.getDashboard({ workspacePath: "/workspaces/demo", teamName: "bravo" });
  assert.equal(noPlan.plan, undefined);
});

test("getDashboard tolerates a team without tasks/inboxes/plan", async () => {
  const service = createTeamsService(dirs());
  const teamDir = join(homeDir, ".zcode", "teams", resolveTeamsWorkspaceKey("/workspaces/demo"), "charlie");
  await mkdir(teamDir, { recursive: true });
  await writeFile(
    join(teamDir, "config.json"),
    JSON.stringify({ name: "charlie", members: [{ agentId: "a1", name: "solo", isActive: false }] }),
    "utf8",
  );
  const dashboard = await service.getDashboard({ workspacePath: "/workspaces/demo", teamName: "charlie" });
  assert.equal(dashboard.team.name, "charlie");
  assert.deepEqual(dashboard.tasks, []);
  assert.deepEqual(dashboard.messages, []);
  assert.equal(dashboard.plan, undefined);
});

test("list projects teamAllowedPaths and omits the field when absent or malformed", async () => {
  const service = createTeamsService(dirs());
  const wsDir = resolveTeamsWorkspaceDir({ workspacePath: "/workspaces/allowed" }, dirs().homeDirResolver);
  const guarded = join(wsDir, "guarded");
  const bare = join(wsDir, "bare");
  await mkdir(guarded, { recursive: true });
  await mkdir(bare, { recursive: true });
  await writeFile(
    join(guarded, "config.json"),
    JSON.stringify({
      name: "guarded",
      members: [{ agentId: "a1", name: "solo", isActive: false }],
      teamAllowedPaths: [
        { path: "/workspaces/demo/docs", toolName: "Read" },
        { path: "/workspaces/demo/docs", toolName: "Edit" },
        // 形状不符的条目被丢弃，不拖垮其余投影。
        { path: 42, toolName: "Read" },
        { path: "/no-tool" },
        "not-an-object",
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(bare, "config.json"),
    JSON.stringify({ name: "bare", members: [{ agentId: "a2", name: "solo", isActive: false }] }),
    "utf8",
  );

  const result = await service.list({ workspacePath: "/workspaces/allowed" });
  assert.equal(result.teams.length, 2);
  const guardedTeam = result.teams.find((team) => team.name === "guarded")!;
  assert.deepEqual(guardedTeam.teamAllowedPaths, [
    { path: "/workspaces/demo/docs", toolName: "Read" },
    { path: "/workspaces/demo/docs", toolName: "Edit" },
  ]);
  // 未配置时字段整体省略，UI 侧据 undefined 显示「未配置」。
  const bareTeam = result.teams.find((team) => team.name === "bare")!;
  assert.equal(bareTeam.teamAllowedPaths, undefined);
});

test("getTeamPlan projects plan.json for the team", async () => {
  const service = createTeamsService(dirs());
  const teamDir = join(homeDir, ".zcode", "teams", resolveTeamsWorkspaceKey("/workspaces/demo"), "echo");
  await mkdir(teamDir, { recursive: true });
  await writeFile(
    join(teamDir, "plan.json"),
    JSON.stringify({
      schemaVersion: 1,
      teamName: "echo",
      sessionId: "s1",
      revision: 2,
      state: "review_pending",
      members: [
        { id: "m1", name: "alice", prompt: "做调研并输出报告", reason: "熟悉领域", difficulty: "low" },
        // 缺 name 的成员被丢弃，不拖垮整份计划。
        { id: "m2", prompt: "缺名字" },
      ],
      tasks: [
        { id: "pt1", subject: "调研", owner: "alice", depends: [] },
        { id: "pt2", subject: "落地", depends: ["调研"] },
      ],
    }),
    "utf8",
  );
  const result = await service.getTeamPlan({ workspacePath: "/workspaces/demo", teamName: "echo" });
  assert.equal(result.plan?.state, "review_pending");
  assert.deepEqual(
    result.plan?.members.map((member) => member.name),
    ["alice"],
  );
  assert.equal(result.plan?.members[0]!.reason, "熟悉领域");
  assert.equal(result.plan?.members[0]!.difficulty, "low");
  assert.equal(result.plan?.tasks.length, 2);
  assert.deepEqual(result.plan?.tasks[1]!.depends, ["调研"]);
});

test("getTeamPlan tolerates missing/corrupt plan.json", async () => {
  const service = createTeamsService(dirs());
  // 不存在 = 该团队没走过计划-审批流，plan 省略。
  const missing = await service.getTeamPlan({ workspacePath: "/workspaces/demo", teamName: "foxtrot" });
  assert.deepEqual(missing, {});

  const teamDir = join(homeDir, ".zcode", "teams", resolveTeamsWorkspaceKey("/workspaces/demo"), "golf");
  await mkdir(teamDir, { recursive: true });
  // 损坏 JSON 同款容忍。
  await writeFile(join(teamDir, "plan.json"), "{ not json", "utf8");
  const corrupt = await service.getTeamPlan({ workspacePath: "/workspaces/demo", teamName: "golf" });
  assert.equal(corrupt.plan, undefined);
  // 形状不符（缺 members/tasks）整体省略。
  await writeFile(join(teamDir, "plan.json"), JSON.stringify({ state: "review_pending" }), "utf8");
  const malformed = await service.getTeamPlan({ workspacePath: "/workspaces/demo", teamName: "golf" });
  assert.equal(malformed.plan, undefined);
});
