// 共享任务列表单测：CAS 防双领与状态机（AC6）

import assert from "node:assert/strict";
import { test } from "node:test";

import { createTeamTask, getTeamTask, listTeamTasks, updateTeamTask } from "../../src/subagent/team/team-tasks.js";
import { teamTest } from "./helpers.js";

test("shared tasks claim with CAS; double-claim conflicts and transitions are ordered (AC6)", async () => {
  const { task } = await createTeamTask(teamTest.deps, "refactor-team", {
    subject: "Refactor storage",
    description: "split store.ts",
  });
  assert.equal(task.status, "pending");
  assert.equal(task.version, 0);

  // 两人按同一版本竞领：后到者按 CAS 冲突失败（顺序确定，先 alice 后 bob）
  const wonA = await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: task.taskId,
    owner: "alice",
    expectedVersion: 0,
  });
  assert.equal(wonA.task!.owner, "alice");
  // 认领 pending 即 in_progress
  assert.equal(wonA.task!.status, "in_progress");
  const claimB = await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: task.taskId,
    owner: "bob",
    expectedVersion: 0,
  });
  assert.equal(claimB.errorCode, "team_task_conflict");
  assert.equal(claimB.task, undefined);

  // in_progress → completed 合法
  const done = await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: task.taskId,
    status: "completed",
  });
  assert.equal(done.task!.status, "completed");

  // 终态回退必须显式 owner 变更
  const reopen = await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: task.taskId,
    status: "in_progress",
  });
  assert.equal(reopen.errorCode, "team_task_reopen_requires_owner");
  const reopened = await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: task.taskId,
    status: "in_progress",
    owner: "bob",
  });
  assert.equal(reopened.task!.status, "in_progress");
  assert.equal(reopened.task!.owner, "bob");

  const list = await listTeamTasks(teamTest.deps, "refactor-team");
  assert.equal(list.tasks.length, 1);
  const got = await getTeamTask(teamTest.deps, "refactor-team", { taskId: task.taskId });
  assert.equal(got.task!.subject, "Refactor storage");
});

test("shared tasks reject unknown ids and terminal completion without owner", async () => {
  const created = await createTeamTask(teamTest.deps, "refactor-team", {
    subject: "Ship nightly",
  });
  // 无 owner 不允许直达终态
  const orphan = await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: created.task.taskId,
    status: "completed",
  });
  assert.equal(orphan.errorCode, "team_task_owner_required");

  const missing = await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: "task_missing",
    status: "in_progress",
  });
  assert.equal(missing.errorCode, "team_task_not_found");

  const missingGet = await getTeamTask(teamTest.deps, "refactor-team", { taskId: "task_missing" });
  assert.match(missingGet.error ?? "", /not found/);
});

test("task completion notifies the lead inbox (positive feedback loop)", async () => {
  const { appendTeamInboxMessage, readTeamInbox } = await import("../../src/subagent/team/team-mailbox.js");
  const { TEAM_LEAD_MEMBER_NAME } = await import("@zcode/contracts");
  const created = await createTeamTask(teamTest.deps, "refactor-team", {
    subject: "Ship feedback loop",
  });

  const sent: string[] = [];
  const notify = (message: { payload: { kind: string } }): Promise<void> => {
    sent.push(message.payload.kind);
    return appendTeamInboxMessage(teamTest.dirs, "refactor-team", TEAM_LEAD_MEMBER_NAME, message as Parameters<typeof appendTeamInboxMessage>[3]);
  };

  // 认领（pending → in_progress）不通知：lead 只在完成/取消/重开时被打扰
  const claimed = await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: created.task.taskId,
    owner: "alice",
    expectedVersion: 0,
  }, { actor: "alice", notifyStatusChange: notify });
  assert.equal(claimed.task!.status, "in_progress");
  assert.deepEqual(sent, []);

  // 完成 → lead 收件箱收到 task_notification，发送方为成员自身
  const done = await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: created.task.taskId,
    status: "completed",
  }, { actor: "alice", notifyStatusChange: notify });
  assert.equal(done.task!.status, "completed");
  assert.deepEqual(sent, ["task_notification"]);

  const leadInbox = await readTeamInbox(teamTest.dirs, "refactor-team", TEAM_LEAD_MEMBER_NAME);
  const taskNotes = leadInbox.messages.filter(
    (message) => message.payload.kind === "task_notification",
  );
  assert.equal(taskNotes.length, 1);
  assert.equal(taskNotes[0]!.from, "alice");
  const payload = taskNotes[0]!.payload as { kind: string; taskId: string; subject: string; status: string };
  assert.equal(payload.status, "completed");
  assert.equal(payload.taskId, created.task.taskId);
  assert.equal(payload.subject, "Ship feedback loop");
});

test("blocked tasks: claim before deps complete is rejected, ready and claimable after (P1)", async () => {
  const { isTaskReady, claimNextReadyTask } = await import("../../src/subagent/team/team-tasks.js");
  const a = await createTeamTask(teamTest.deps, "refactor-team", { subject: "A: schema" });
  const b = await createTeamTask(teamTest.deps, "refactor-team", {
    subject: "B: api",
    blockedBy: [a.task.taskId],
  });
  assert.equal(b.task.blockedBy?.[0], a.task.taskId);

  // A 未完成时认领 B 被拒
  const blocked = await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: b.task.taskId,
    owner: "alice",
    expectedVersion: b.task.version,
  });
  assert.equal(blocked.errorCode, "team_task_blocked");

  // 自动认领跳过被阻塞的 B，只认领 ready 任务（同文件前序用例可能遗留 ready 任务：排空并逐个断言不是 B）
  for (let i = 0; i < 20; i++) {
    const claimed = await claimNextReadyTask(teamTest.deps, "refactor-team", "alice");
    if (claimed === undefined) break;
    assert.notEqual(claimed.taskId, b.task.taskId);
  }

  // A 完成后 B ready 可认领（显式认领不带 CAS 版本号，避免与排空顺序耦合）
  await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: a.task.taskId,
    owner: "alice",
    status: "in_progress",
  });
  const finishA = await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: a.task.taskId,
    status: "completed",
  });
  assert.equal(finishA.task.status, "completed");

  // A 完成后 B ready 可认领；自动认领无可认领返回 undefined
  assert.equal(isTaskReady((await listTeamTasks(teamTest.deps, "refactor-team")).tasks, { blockedBy: b.task.blockedBy }), true);
  const claimB = await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: b.task.taskId,
    owner: "bob",
    expectedVersion: b.task.version,
  });
  assert.equal(claimB.task.status, "in_progress");
  assert.equal(await claimNextReadyTask(teamTest.deps, "refactor-team", "carol"), undefined);
});

test("review verdict: approve records acceptance, revise reopens with comment and notifies owner (P3)", async () => {
  const { appendTeamInboxMessage } = await import("../../src/subagent/team/team-mailbox.js");
  const created = await createTeamTask(teamTest.deps, "refactor-team", { subject: "Reviewable work" });
  const ownerInbox = [];
  const notifyMember = (memberName, message) => {
    ownerInbox.push({ memberName, text: message.payload.text });
    return appendTeamInboxMessage(teamTest.dirs, "refactor-team", memberName, message);
  };
  const claimed = await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: created.task.taskId,
    owner: "alice",
    expectedVersion: created.task.version,
  });
  assert.equal(claimed.task.status, "in_progress");
  const done = await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: created.task.taskId,
    status: "completed",
  });
  assert.equal(done.task.status, "completed");

  // revise 必须带意见
  const noComment = await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: created.task.taskId,
    reviewVerdict: "revise",
  });
  assert.equal(noComment.errorCode, "team_task_review_comment_required");

  // revise:回退 in_progress + attempts+1 + owner 收件箱收到评审意见
  const revised = await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: created.task.taskId,
    reviewVerdict: "revise",
    reviewComment: "Edge case missing: empty payload should 4xx.",
  }, { actor: "team_lead", notifyMember });
  assert.equal(revised.task.status, "in_progress");
  assert.equal(revised.task.reviewStatus, "rework");
  assert.equal(revised.task.attempts, 2);
  assert.equal(ownerInbox.length, 1);
  assert.match(ownerInbox[0].text, /REWORK/);
  assert.match(ownerInbox[0].text, /empty payload/);

  // 返工后再次完成,验收通过
  const redone = await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: created.task.taskId,
    status: "completed",
  });
  assert.equal(redone.task.status, "completed");
  const approved = await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: created.task.taskId,
    reviewVerdict: "approve",
  }, { actor: "team_lead", notifyMember });
  assert.equal(approved.task.reviewStatus, "approved");
  assert.equal(approved.task.status, "completed");

  // 非 completed 任务不能验收
  const created2 = await createTeamTask(teamTest.deps, "refactor-team", { subject: "Pending work" });
  const early = await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: created2.task.taskId,
    reviewVerdict: "approve",
  });
  assert.equal(early.errorCode, "team_task_review_requires_completed");
});

test("readiness: cancelled deps unblock; release returns member tasks to pool (v2.6)", async () => {
  const { isTaskReady, releaseMemberTasks } = await import("../../src/subagent/team/team-tasks.js");
  const { appendTeamInboxMessage, readTeamInbox } = await import("../../src/subagent/team/team-mailbox.js");
  const { TEAM_LEAD_MEMBER_NAME } = await import("@zcode/contracts");

  const a = await createTeamTask(teamTest.deps, "refactor-team", { subject: "A: base" });
  const b = await createTeamTask(teamTest.deps, "refactor-team", {
    subject: "B: depends on A",
    blockedBy: [a.task.taskId],
  });

  // 依赖 A 未完成 → B 不 ready
  assert.equal(
    isTaskReady((await listTeamTasks(teamTest.deps, "refactor-team")).tasks, { blockedBy: b.task.blockedBy }),
    false,
  );

  // 取消 A → 解除阻塞,B ready(v2.6:cancelled 视为解除阻塞)
  await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: a.task.taskId,
    owner: "alice",
    expectedVersion: a.task.version,
  });
  const cancelled = await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: a.task.taskId,
    status: "cancelled",
  });
  assert.equal(cancelled.task.status, "cancelled");
  assert.equal(
    isTaskReady((await listTeamTasks(teamTest.deps, "refactor-team")).tasks, { blockedBy: b.task.blockedBy }),
    true,
  );

  // release:用全新成员 zara 认领 B 后中止 → 任务回池(成员名与前序用例解耦,避免把遗留任务一起释放)
  await updateTeamTask(teamTest.deps, "refactor-team", {
    taskId: b.task.taskId,
    owner: "zara",
    status: "in_progress",
  });
  const released = await releaseMemberTasks(teamTest.deps, "refactor-team", "zara", {
    notifyStatusChange: (message) =>
      appendTeamInboxMessage(teamTest.dirs, "refactor-team", TEAM_LEAD_MEMBER_NAME, message),
  });
  assert.equal(released.length, 1);
  assert.equal(released[0].taskId, b.task.taskId);
  assert.equal(released[0].status, "pending");
  assert.equal(released[0].owner, undefined);
  const leadInbox = await readTeamInbox(teamTest.dirs, "refactor-team", TEAM_LEAD_MEMBER_NAME);
  const poolNotes = leadInbox.messages.filter(
    (message) => message.payload.kind === "task_notification" && message.payload.status === "pending",
  );
  assert.equal(poolNotes.length, 1);
  assert.equal(poolNotes[0].from, "zara");
});
