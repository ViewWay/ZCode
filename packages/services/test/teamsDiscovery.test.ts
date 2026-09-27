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
