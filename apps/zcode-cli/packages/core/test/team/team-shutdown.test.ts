// 团队关停（AC5 完整语义）与 AC7 会话清理单测

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cleanupSessionTeamRuntime,
  shutdownTeamRuntime,
  type TeammateRuntimeHandle,
} from "../../src/subagent/team/team-shutdown.js";
import { deleteTeamDir, loadTeamFile } from "../../src/subagent/team/team-store.js";
import { teamTest } from "./helpers.js";

/**
 * 模拟 teammate 监督循环：轮询自身收件箱，消费 shutdown_request 后自摘成员
 * （与生产 supervisor 同语义）；abort 仅停止轮询（强制终止路径），自计次数。
 */
function fakeTeammate(
  teamName: string,
  name: string,
  options?: { ignoreShutdown?: boolean },
): TeammateRuntimeHandle & { aborts(): number } {
  let abortCount = 0;
  const controller = new AbortController();
  void pollShutdown();
  return {
    name,
    abort: () => {
      abortCount += 1;
      controller.abort();
    },
    done: Promise.resolve(),
    aborts: () => abortCount,
  };

  async function pollShutdown(): Promise<void> {
    while (!controller.signal.aborted) {
      const { readTeamInbox } = await import("../../src/subagent/team/team-mailbox.js");
      const { newlyRead } = await readTeamInbox(teamTest.dirs, teamName, name, { markRead: true });
      if (
        newlyRead.some((message) => message.payload.kind === "shutdown_request") &&
        options?.ignoreShutdown !== true
      ) {
        const { removeTeamMember } = await import("../../src/subagent/team/team-store.js");
        await removeTeamMember(teamTest.deps, teamName, name);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
}

async function seedShutdownTeam(
  teamName: string,
  teammateNames: string[],
): Promise<void> {
  const { createOrGetTeam, addTeamMember } = await import("../../src/subagent/team/team-store.js");
  await createOrGetTeam(teamTest.deps, {
    name: teamName,
    leadAgentId: "lead_s1",
    leadWorkingDirectory: "/workspaces/demo",
  });
  for (const name of teammateNames) {
    await addTeamMember(teamTest.deps, teamName, {
      agentId: `agent_${name}`,
      name,
      cwd: "/workspaces/demo",
      isActive: true,
      joinedAt: new Date().toISOString(),
    });
  }
}

test("shutdownTeamRuntime returns not_found for missing team", async () => {
  const outcome = await shutdownTeamRuntime(
    { dirs: teamTest.dirs, listTeammates: () => [] },
    "no-such-team",
    "team_lead",
  );
  assert.deepEqual(outcome, { status: "not_found", requested: 0, exited: 0 });
});

test("shutdownTeamRuntime waits for voluntary exits then deletes the dir (AC5)", async () => {
  await seedShutdownTeam("sd-team", ["alice", "bob"]);
  const handles = [fakeTeammate("sd-team", "alice"), fakeTeammate("sd-team", "bob")];
  const outcome = await shutdownTeamRuntime(
    { dirs: teamTest.dirs, listTeammates: () => handles },
    "sd-team",
    "team_lead",
    { timeoutMs: 2000, pollIntervalMs: 5 },
  );
  assert.equal(outcome.status, "deleted");
  assert.equal(outcome.requested, 2);
  assert.equal(outcome.exited, 2);
  const team = await loadTeamFile(teamTest.deps, "sd-team");
  assert.equal(team, undefined);
});

test("shutdownTeamRuntime force-aborts teammates that do not converge in time", async () => {
  await seedShutdownTeam("sd-force", ["carol"]);
  const handle = fakeTeammate("sd-force", "carol", { ignoreShutdown: true });
  // carol 忽略 shutdown_request（模拟审批挂起）：窗口到期走强制终止路径。
  const outcome = await shutdownTeamRuntime(
    { dirs: teamTest.dirs, listTeammates: () => [handle] },
    "sd-force",
    "team_lead",
    { timeoutMs: 30, pollIntervalMs: 5 },
  );
  assert.equal(outcome.status, "deleted");
  assert.equal(outcome.requested, 1);
  assert.equal(outcome.exited, 0);
  const team = await loadTeamFile(teamTest.deps, "sd-force");
  assert.equal(team, undefined);
});

test("cleanupSessionTeamRuntime aborts all teammates and deletes the dir (AC7)", async () => {
  await seedShutdownTeam("sd-ac7", ["alice", "bob"]);
  const handles = [fakeTeammate("sd-ac7", "alice"), fakeTeammate("sd-ac7", "bob")];
  await cleanupSessionTeamRuntime(
    { dirs: teamTest.dirs, listTeammates: () => handles },
    "sd-ac7",
  );
  for (const handle of handles) {
    assert.equal(handle.aborts(), 1);
  }
  const team = await loadTeamFile(teamTest.deps, "sd-ac7");
  assert.equal(team, undefined);
});
