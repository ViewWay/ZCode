// lead 收件箱消费循环单测：回灌通知、确认读、团队删除自停

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appendTeamInboxMessage,
  buildTeamMailboxMessage,
} from "../../src/subagent/team/team-mailbox.js";
import { deleteTeamDir } from "../../src/subagent/team/team-store.js";
import {
  formatLeadInboxNotification,
  runLeadInboxPoller,
} from "../../src/subagent/team/lead-inbox-poller.js";
import { teamTest } from "./helpers.js";

async function seedPollerTeam(teamName: string, teammateName: string): Promise<void> {
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

test("poller converts new inbox messages to parent notifications and marks read", async () => {
  await seedPollerTeam("poll-team", "alice");
  await appendTeamInboxMessage(
    teamTest.dirs,
    "poll-team",
    "team_lead",
    buildTeamMailboxMessage({
      from: "alice",
      to: "team_lead",
      payload: { kind: "text", text: "progress update" },
    }),
  );
  const enqueued: Array<{ taskId: string; text: string }> = [];
  const controller = new AbortController();
  const { done } = runLeadInboxPoller({
    deps: teamTest.deps,
    dirs: teamTest.dirs,
    teamName: "poll-team",
    leadName: "team_lead",
    enqueue: (notification) => {
      enqueued.push({ taskId: notification.taskId, text: notification.text });
      return undefined;
    },
    baseTraceContext: { traceId: "trace-1" },
    signal: controller.signal,
    pollIntervalMs: 5,
  });
  for (let i = 0; i < 40 && enqueued.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(enqueued.length >= 1, "notification should be enqueued");
  assert.ok(enqueued[0]!.text.includes("alice"), "notification names the teammate");
  assert.ok(enqueued[0]!.text.includes("progress update"), "notification carries the text");
  assert.equal(enqueued[0]!.taskId, "team:poll-team");
  // 确认读：历史消息不重复回灌
  controller.abort();
  await done;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(enqueued.length === 1, "no duplicate enqueue after markRead");
});

test("poller stops on its own when the team directory is deleted", async () => {
  await seedPollerTeam("poll-team2", "bob");
  const controller = new AbortController();
  const { done } = runLeadInboxPoller({
    deps: teamTest.deps,
    dirs: teamTest.dirs,
    teamName: "poll-team2",
    leadName: "team_lead",
    enqueue: () => undefined,
    baseTraceContext: { traceId: "trace-2" },
    signal: controller.signal,
    pollIntervalMs: 5,
  });
  await deleteTeamDir(teamTest.deps, "poll-team2");
  await done;
  // done 在 TeamFile 删除后自行 resolve；signal 未 abort 也要退出。
  assert.ok(controller.signal.aborted === false);
});

test("formatLeadInboxNotification renders idle and shutdown receipts", () => {
  const idle = formatLeadInboxNotification("t1", {
    id: "m1",
    from: "alice",
    to: "team_lead",
    payload: { kind: "idle_notification", idleReason: "available" },
    sentAt: new Date().toISOString(),
    read: false,
  });
  assert.ok(idle.includes("idle"), idle);
  assert.ok(idle.includes("alice"), idle);

  const receipt = formatLeadInboxNotification("t1", {
    id: "m2",
    from: "bob",
    to: "team_lead",
    payload: { kind: "shutdown_response", approve: true },
    sentAt: new Date().toISOString(),
    read: false,
  });
  assert.ok(receipt.includes("approved"), receipt);
});

test("formatLeadInboxNotification renders task notifications", async () => {
  const { strict: assert } = await import("node:assert/strict");
  const { formatLeadInboxNotification } = await import("../../src/subagent/team/lead-inbox-poller.js");
  const message = {
    id: "msg_task_note",
    from: "alice",
    to: "team_lead",
    payload: { kind: "task_notification", taskId: "task_1", subject: "Ship it", status: "completed", actor: "alice" },
    sentAt: new Date().toISOString(),
    read: false,
  };
  const text = formatLeadInboxNotification("demo", message);
  assert.match(text, /alice completed task "Ship it" \(task_1\)/);

  const reopened = {
    ...message,
    payload: { kind: "task_notification", taskId: "task_1", subject: "Ship it", status: "in_progress", actor: "team_lead" },
  };
  assert.match(formatLeadInboxNotification("demo", reopened), /reopened task "Ship it"/);
});
