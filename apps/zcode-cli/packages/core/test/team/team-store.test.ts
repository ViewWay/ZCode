// TeamFile 存储层单测：路径/名字安全 + 幂等创建 + 成员保护（AC1、AC2 半边）

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isSafeTeamPathSegment,
  resolveTeamIdentityKey,
  resolveWorkspaceKey,
} from "../../src/subagent/team/team-paths.js";
import {
  addTeamMember,
  createOrGetTeam,
  deleteTeamDir,
  listTeamNames,
  loadTeamFile,
  resolveSingleTeamName,
  setTeamMemberActive,
  TeamMemberLimitError,
  TeamStoreError,
  updateTeamFile,
} from "../../src/subagent/team/team-store.js";
import { appendTeamInboxMessage, buildTeamMailboxMessage } from "../../src/subagent/team/team-mailbox.js";
import { teamTest } from "./helpers.js";

test("workspace key derives a stable filesystem-safe hash from the identity key", () => {
  const key = resolveWorkspaceKey(resolveTeamIdentityKey({ workspacePath: "/workspaces/demo" }));
  assert.match(key, /^[0-9a-f]{12}$/);
  // 身份优先于路径（Workspace Identity 规则）
  assert.equal(
    resolveTeamIdentityKey({ workspaceIdentity: "remote-abc", workspacePath: "/workspaces/demo" }),
    "remote-abc",
  );
  assert.equal(key, resolveWorkspaceKey(resolveTeamIdentityKey({ workspacePath: "/workspaces/demo" })));
  assert.notEqual(
    key,
    resolveWorkspaceKey(resolveTeamIdentityKey({ workspacePath: "/workspaces/other" })),
  );
});

test("isSafeTeamPathSegment rejects traversal, separators and Windows reserved names", () => {
  assert.equal(isSafeTeamPathSegment("refactor-team"), true);
  assert.equal(isSafeTeamPathSegment("Team 01"), true);
  assert.equal(isSafeTeamPathSegment("../escape"), false);
  assert.equal(isSafeTeamPathSegment("a/b"), false);
  assert.equal(isSafeTeamPathSegment("a\\b"), false);
  assert.equal(isSafeTeamPathSegment("con"), false);
  assert.equal(isSafeTeamPathSegment("NUL.txt"), false);
  assert.equal(isSafeTeamPathSegment("-leading"), false);
  assert.equal(isSafeTeamPathSegment(""), false);
});

test("createOrGetTeam is idempotent and registers the lead member (AC1)", async () => {
  const first = await createOrGetTeam(teamTest.deps, {
    name: "refactor-team",
    description: "demo",
    leadAgentId: "lead_s1",
    leadSessionId: "s1",
    leadWorkingDirectory: "/workspaces/demo",
  });
  assert.equal(first.status, "created");
  assert.equal(first.team.members.length, 1);
  assert.equal(first.team.members[0]!.name, "team_lead");
  assert.equal(first.team.leadSessionId, "s1");

  const second = await createOrGetTeam(teamTest.deps, {
    name: "refactor-team",
    leadAgentId: "lead_s2",
    leadSessionId: "s2",
    leadWorkingDirectory: "/workspaces/demo",
  });
  assert.equal(second.status, "existing");
  // 幂等返回既有团队，不覆盖 lead 事实
  assert.equal(second.team.leadSessionId, "s1");

  const loaded = await loadTeamFile(teamTest.deps, "refactor-team");
  assert.ok(loaded);
  assert.equal(loaded.name, "refactor-team");
  assert.deepEqual(await listTeamNames(teamTest.deps), ["refactor-team"]);
});

test("addTeamMember rejects duplicate names and enforces the member cap (AC2)", async () => {
  await createOrGetTeam(teamTest.deps, {
    name: "cap-team",
    leadAgentId: "lead_s1",
    leadWorkingDirectory: "/workspaces/demo",
  });
  for (let i = 0; i < 7; i++) {
    await addTeamMember(teamTest.deps, "cap-team", {
      agentId: `agent_${i}`,
      name: `mate_${i}`,
      cwd: "/workspaces/demo",
      isActive: false,
      joinedAt: new Date().toISOString(),
    });
  }
  // 第 9 个成员（lead + 8）被拒
  await assert.rejects(
    addTeamMember(teamTest.deps, "cap-team", {
      agentId: "agent_x",
      name: "overflow",
      cwd: "/workspaces/demo",
      isActive: false,
      joinedAt: new Date().toISOString(),
    }),
    TeamMemberLimitError,
  );

  // 同名重复 spawn 报错而非覆盖（AC2）
  await assert.rejects(
    addTeamMember(teamTest.deps, "cap-team", {
      agentId: "agent_dup",
      name: "mate_0",
      cwd: "/workspaces/demo",
      isActive: false,
      joinedAt: new Date().toISOString(),
    }),
    (error: unknown) => error instanceof TeamStoreError && error.message.includes("already exists"),
  );
});

test("setTeamMemberActive and updateTeamFile round-trip roster state", async () => {
  await createOrGetTeam(teamTest.deps, {
    name: "state-team",
    leadAgentId: "lead_s1",
    leadWorkingDirectory: "/workspaces/demo",
  });
  await addTeamMember(teamTest.deps, "state-team", {
    agentId: "agent_a",
    name: "alice",
    cwd: "/workspaces/demo",
    isActive: false,
    joinedAt: new Date().toISOString(),
  });
  await setTeamMemberActive(teamTest.deps, "state-team", "alice", true);
  const team = await loadTeamFile(teamTest.deps, "state-team");
  assert.equal(team!.members.find((member) => member.name === "alice")!.isActive, true);

  await updateTeamFile(teamTest.deps, "state-team", (current) => ({
    value: current.members.length,
    team: current,
  }));
  // 不存在的团队报业务错误而非静默
  await assert.rejects(
    updateTeamFile(teamTest.deps, "missing-team", (current) => ({ value: current, team: current })),
    TeamStoreError,
  );
});

test("deleteTeamDir is idempotent and removes registry, mailboxes and tasks", async () => {
  await createOrGetTeam(teamTest.deps, {
    name: "gone-team",
    leadAgentId: "lead_s1",
    leadWorkingDirectory: "/workspaces/demo",
  });
  await appendTeamInboxMessage(
    teamTest.dirs,
    "gone-team",
    "team_lead",
    buildTeamMailboxMessage({ from: "alice", to: "team_lead", payload: { kind: "text", text: "hi" } }),
  );
  assert.equal((await deleteTeamDir(teamTest.deps, "gone-team")).deleted, true);
  assert.equal((await deleteTeamDir(teamTest.deps, "gone-team")).deleted, false);
  assert.equal(await loadTeamFile(teamTest.deps, "gone-team"), undefined);
});

test("resolveSingleTeamName requires exactly one team for shared tasks", async () => {
  const solo = await teamTest.isolated();
  try {
    await assert.rejects(resolveSingleTeamName(solo.deps), TeamStoreError);
    await createOrGetTeam(solo.deps, {
      name: "only-team",
      leadAgentId: "lead_s1",
      leadWorkingDirectory: "/workspaces/solo",
    });
    assert.equal(await resolveSingleTeamName(solo.deps), "only-team");
    await createOrGetTeam(solo.deps, {
      name: "second-team",
      leadAgentId: "lead_s1",
      leadWorkingDirectory: "/workspaces/solo",
    });
    await assert.rejects(resolveSingleTeamName(solo.deps), (error: unknown) =>
      error instanceof TeamStoreError && error.message.includes("Multiple teams"),
    );
  } finally {
    await solo.cleanup();
  }
});
