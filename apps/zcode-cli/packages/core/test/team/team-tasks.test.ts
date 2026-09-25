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
