// teammate 监督循环单测：空闲轮询、消息驱动 resume、关停语义（AC5 半边）

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appendTeamInboxMessage,
  buildTeamMailboxMessage,
  readTeamInbox,
  type TeamMailboxMessage,
} from "../../src/subagent/team/team-mailbox.js";
import { loadTeamFile } from "../../src/subagent/team/team-store.js";
import { runTeammateSupervisor } from "../../src/subagent/team/teammate-supervisor.js";
import { teamTest } from "./helpers.js";

async function seedTeammate(teamName: string, teammateName: string): Promise<void> {
  const { createOrGetTeam, addTeamMember } = await import("../../src/subagent/team/team-store.js");
  await createOrGetTeam(teamTest.deps, {
    name: teamName,
    leadAgentId: "lead_s1",
    leadWorkingDirectory: "/workspaces/demo",
  });
  await addTeamMember(teamTest.deps, teamName, {
    agentId: `agent_${teammateName}`,
    name: teammateName,
    cwd: "/workspaces/demo",
    isActive: true,
    joinedAt: new Date().toISOString(),
  });
}

test("supervisor resumes a turn when a text message arrives and flips isActive", async () => {
  await seedTeammate("sup-team", "alice");
  await appendTeamInboxMessage(
    teamTest.dirs,
    "sup-team",
    "alice",
    buildTeamMailboxMessage({ from: "team_lead", to: "alice", payload: { kind: "text", text: "do it" } }),
  );

  // 修复说明：原用例把 terminal=false 注释为「空闲」，与监督循环语义相反
  // （terminal=true = 空闲/idle，terminal=false = turn 运行中），且在 abort 摘除
  // 成员之后才断言 isActive。重写为确定性三阶段：空闲即消费 → 运行中 isActive=true
  // → 回到空闲 isActive=false 且不二次 resume → abort 摘除成员（用例 3 语义）。
  let terminal = true; // 首轮已完成，处于空闲：监督循环应立即消费邮箱并 resume
  const resumed: TeamMailboxMessage[] = [];
  const controller = new AbortController();
  const { done } = runTeammateSupervisor({
    deps: teamTest.deps,
    dirs: teamTest.dirs,
    teamName: "sup-team",
    teammateName: "alice",
    leadName: "team_lead",
    agentId: "agent_alice",
    signal: controller.signal,
    isTaskTerminal: () => terminal,
    resumeTurn: async (message) => {
      resumed.push(message);
      // 模拟 turn 进入 running
      terminal = false;
    },
    onShutdown: async () => {},
    pollIntervalMs: 5,
    activeProbeIntervalMs: 5,
  });

  // 阶段 A：空闲即消费；resume 后 turn 运行中，isActive 落盘为 true
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resumed.length, 1);
  assert.equal((resumed[0]!.payload as { kind: string; text: string }).text, "do it");
  const runningTeam = await loadTeamFile(teamTest.deps, "sup-team");
  assert.equal(runningTeam!.members.find((member) => member.name === "alice")!.isActive, true);

  // 阶段 B：turn 结束回到空闲 → isActive 落盘为 false；确认读后历史消息不二次 resume
  terminal = true;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resumed.length, 1);
  const idleTeam = await loadTeamFile(teamTest.deps, "sup-team");
  assert.equal(idleTeam!.members.find((member) => member.name === "alice")!.isActive, false);
  // idle 通知（specs/agent-teams.md）：true→false 翻转时向 lead 收件箱写 idle_notification
  const leadInbox = await readTeamInbox(teamTest.dirs, "sup-team", "team_lead");
  const idleNotices = leadInbox.messages.filter(
    (message) => message.payload.kind === "idle_notification",
  );
  assert.equal(idleNotices.length, 1);
  assert.equal(idleNotices[0]!.from, "alice");

  // 阶段 C：abort 即 TeamDelete/会话终止路径，成员被摘除（与用例 3 一致）
  controller.abort();
  await done;
  const team = await loadTeamFile(teamTest.deps, "sup-team");
  assert.equal(team!.members.find((member) => member.name === "alice"), undefined);
});

test("supervisor handles shutdown_request: runs onShutdown and removes the member (AC5)", async () => {
  await seedTeammate("sup-team", "bob");
  await appendTeamInboxMessage(
    teamTest.dirs,
    "sup-team",
    "bob",
    buildTeamMailboxMessage({
      from: "team_lead",
      to: "bob",
      payload: { kind: "shutdown_request", reason: "team disbanding" },
    }),
  );

  let shutdowns = 0;
  const controller = new AbortController();
  const { done } = runTeammateSupervisor({
    deps: teamTest.deps,
    dirs: teamTest.dirs,
    teamName: "sup-team",
    teammateName: "bob",
    leadName: "team_lead",
    agentId: "agent_bob",
    signal: controller.signal,
    isTaskTerminal: () => true,
    resumeTurn: async () => assert.fail("shutdown must not resume a turn"),
    onShutdown: async () => {
      shutdowns += 1;
    },
    pollIntervalMs: 5,
    activeProbeIntervalMs: 5,
  });

  await done;
  assert.equal(shutdowns, 1);
  const team = await loadTeamFile(teamTest.deps, "sup-team");
  assert.equal(team!.members.find((member) => member.name === "bob"), undefined);
  // 关停回执（AC5 闭环）：批准后向 lead 收件箱回 shutdown_response
  const leadInbox = await readTeamInbox(teamTest.dirs, "sup-team", "team_lead");
  const receipts = leadInbox.messages.filter(
    (message) => message.payload.kind === "shutdown_response",
  );
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.from, "bob");
  assert.equal(
    (receipts[0]!.payload as { kind: string; approve: boolean }).approve,
    true,
  );
});

test("supervisor exits on abort and removes the member (TeamDelete path)", async () => {
  await seedTeammate("sup-team", "carol");
  const controller = new AbortController();
  const { done } = runTeammateSupervisor({
    deps: teamTest.deps,
    dirs: teamTest.dirs,
    teamName: "sup-team",
    teammateName: "carol",
    leadName: "team_lead",
    agentId: "agent_carol",
    signal: controller.signal,
    isTaskTerminal: () => true,
    resumeTurn: async () => {},
    onShutdown: async () => {},
    pollIntervalMs: 5,
    activeProbeIntervalMs: 5,
  });

  controller.abort();
  await done;
  const team = await loadTeamFile(teamTest.deps, "sup-team");
  assert.equal(team!.members.find((member) => member.name === "carol"), undefined);
});

test("teammate identity helpers: gate config resolution and message sender", async () => {
  const { resolveTeammateIdentity } = await import("../../src/runtime/helpers/runtime-tools.js");
  const { resolveTeamMessageSender } = await import("../../src/tool/handlers/send-message.js");
  const { TEAM_LEAD_MEMBER_NAME } = await import("@zcode/contracts");

  // 主会话/普通 subagent：无身份 → 门控关闭、发送方仍是 lead
  assert.equal(resolveTeammateIdentity({}), undefined);
  assert.equal(resolveTeamMessageSender({}), TEAM_LEAD_MEMBER_NAME);
  // teammate 会话：身份驱动门控，SendMessage 发送方为成员自身
  const identity = { teamName: "sup-team", memberName: "alice" };
  assert.deepEqual(resolveTeammateIdentity({ teamMemberIdentity: identity }), identity);
  assert.equal(resolveTeamMessageSender({ teamMemberIdentity: identity }), "alice");
});

test("supervisor auto-claims a ready task when idle (P1)", async () => {
  const { createTeamTask, claimNextReadyTask } = await import("../../src/subagent/team/team-tasks.js");
  const { buildTeamMailboxMessage } = await import("../../src/subagent/team/team-mailbox.js");
  await seedTeammate("sup-team", "dave");
  const created = await createTeamTask(teamTest.deps, "sup-team", { subject: "Auto work" });
  const resumed = [];
  const controller = new AbortController();
  const supervisor = runTeammateSupervisor({
    deps: teamTest.deps,
    dirs: teamTest.dirs,
    teamName: "sup-team",
    teammateName: "dave",
    leadName: "team_lead",
    agentId: "agent_dave",
    signal: controller.signal,
    isTaskTerminal: () => true,
    autoClaimTask: async () => {
      const claimed = await claimNextReadyTask(teamTest.deps, "sup-team", "dave");
      if (claimed === undefined) return undefined;
      return buildTeamMailboxMessage({
        from: "team_lead",
        to: "dave",
        payload: { kind: "text", text: "Auto-claimed \"" + claimed.subject + "\" (" + claimed.taskId + ")" },
      });
    },
    resumeTurn: async (message) => {
      resumed.push(message.payload.kind === "text" ? message.payload.text : "non-text");
    },
    onShutdown: async () => {},
    pollIntervalMs: 5,
    activeProbeIntervalMs: 5,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  controller.abort();
  await supervisor.done;
  assert.equal(resumed.length, 1);
  assert.match(resumed[0], /Auto work/);
});
