// 团队计划状态机单测(v2.10):draft → review_pending → approved,
// CAS 防并发、终态锁定(team_plan_locked)、引用校验与驳回-修订循环。

import assert from "node:assert/strict";
import { test } from "node:test";

import { createOrGetTeam } from "../../src/subagent/team/team-store.js";
import {
  approveTeamPlan,
  readTeamPlan,
  replaceTeamPlan,
  submitTeamPlan,
  TeamPlanStoreError,
} from "../../src/subagent/team/team-plan.js";
import { teamPlanApproveToolEntry, teamPlanToolEntry } from "../../src/tool/handlers/team-plan.js";
import type { ToolExecutionContext } from "../../src/tool/types.js";
import { teamTest } from "./helpers.js";

const MEMBER = { id: "be", name: "backend", prompt: "You own the storage layer" };
const TASK = { id: "t1", subject: "Split store.ts", owner: "backend" };

async function createTeam(name: string): Promise<void> {
  await createOrGetTeam(teamTest.deps, {
    name,
    leadAgentId: "lead_test",
    leadWorkingDirectory: "/workspaces/demo",
  });
}

function planContext(): ToolExecutionContext {
  return {
    toolCallId: "test-call",
    traceId: "test-trace" as ToolExecutionContext["traceId"],
    abortSignal: new AbortController().signal,
    workspaceRoot: "/workspaces/demo",
    workingDirectory: "/workspaces/demo",
    sessionId: "sess_test",
  } as ToolExecutionContext;
}

async function assertRejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof TeamPlanStoreError, `expected TeamPlanStoreError, got: ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected TeamPlanStoreError with code ${code}, but the promise resolved`);
}

test("team plan lifecycle: draft rev1 → submit → approve; approved locks writes; CAS conflicts", async () => {
  await createTeam("plan-a");

  // get 无计划:store 读为 undefined,handler 报 team_plan_not_found。
  assert.equal(await readTeamPlan(teamTest.deps, "plan-a"), undefined);

  // replace 创建 draft revision 1。
  const draft = await replaceTeamPlan(teamTest.deps, "plan-a", {
    sessionId: "sess_1",
    members: [MEMBER],
    tasks: [TASK],
  });
  assert.equal(draft.state, "draft");
  assert.equal(draft.revision, 1);
  assert.equal(draft.sessionId, "sess_1");

  // approve 未 submit:draft 直接批 → 拒绝。
  await assertRejectsWithCode(
    approveTeamPlan(teamTest.deps, "plan-a", { expectedRevision: 1 }),
    "team_plan_not_review_pending",
  );

  // CAS:过期的 expectedRevision 拒绝。
  await assertRejectsWithCode(
    submitTeamPlan(teamTest.deps, "plan-a", { expectedRevision: 99 }),
    "team_plan_conflict",
  );

  // submit → review_pending,revision +1。
  const pending = await submitTeamPlan(teamTest.deps, "plan-a", { expectedRevision: 1 });
  assert.equal(pending.state, "review_pending");
  assert.equal(pending.revision, 2);

  // CAS:submit 后再按旧 revision replace → 冲突。
  await assertRejectsWithCode(
    replaceTeamPlan(teamTest.deps, "plan-a", {
      sessionId: "sess_1",
      members: [MEMBER],
      tasks: [TASK],
      expectedRevision: 1,
    }),
    "team_plan_conflict",
  );

  // approve → approved,盖 approvedAt 时间戳。
  const approved = await approveTeamPlan(teamTest.deps, "plan-a", { expectedRevision: 2 });
  assert.equal(approved.state, "approved");
  assert.equal(approved.revision, 3);
  assert.ok(approved.approvedAt !== undefined);

  // approved 后写入全部锁定(team_plan_locked),与 revision 是否匹配无关。
  await assertRejectsWithCode(
    replaceTeamPlan(teamTest.deps, "plan-a", {
      sessionId: "sess_1",
      members: [MEMBER],
      tasks: [TASK],
      expectedRevision: 3,
    }),
    "team_plan_locked",
  );
  await assertRejectsWithCode(
    submitTeamPlan(teamTest.deps, "plan-a", { expectedRevision: 3 }),
    "team_plan_locked",
  );
  await assertRejectsWithCode(
    approveTeamPlan(teamTest.deps, "plan-a", { expectedRevision: 3 }),
    "team_plan_locked",
  );

  // 磁盘事实:plan.json 落在团队目录内,批准态可回读。
  const reread = await readTeamPlan(teamTest.deps, "plan-a");
  assert.equal(reread?.state, "approved");
  assert.equal(reread?.revision, 3);
});

test("team plan handlers: get/replace/submit via TeamPlan; approve only via TeamPlanApprove", async () => {
  await createTeam("plan-b");
  const context = planContext();
  // handler 按默认 homedir 解析团队根(os.homedir 在 POSIX 逐次读 HOME);
  // 测试期内把 HOME 指向夹具的临时目录,使 handler 与 teamTest.deps 同一存储根。
  const previousHome = process.env.HOME;
  process.env.HOME = teamTest.homeDir;
  try {
    await testTeamPlanHandlers(context);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

async function testTeamPlanHandlers(context: ToolExecutionContext): Promise<void> {

  // get 无计划报错。
  const missing = (await teamPlanToolEntry.handler(
    { team_name: "plan-b", operation: "get" },
    context,
  )) as { status: string; errorCode?: string };
  assert.equal(missing.status, "error");
  assert.equal(missing.errorCode, "team_plan_not_found");

  // replace 创建。
  const created = (await teamPlanToolEntry.handler(
    {
      team_name: "plan-b",
      operation: "replace",
      plan: { members: [MEMBER], tasks: [TASK] },
    },
    context,
  )) as { status: string; plan?: { revision: number; state: string } };
  assert.equal(created.status, "ok");
  assert.equal(created.plan?.state, "draft");
  assert.equal(created.plan?.revision, 1);

  // 计划已存在时缺 expected_revision → 冲突。
  const noRevision = (await teamPlanToolEntry.handler(
    { team_name: "plan-b", operation: "replace", plan: { members: [MEMBER], tasks: [TASK] } },
    context,
  )) as { status: string; errorCode?: string };
  assert.equal(noRevision.status, "error");
  assert.equal(noRevision.errorCode, "team_plan_conflict");

  // TeamPlan 不许 approve:制度性边界,批准只能走 TeamPlanApprove 的确认窗。
  const selfApprove = (await teamPlanToolEntry.handler(
    { team_name: "plan-b", operation: "approve", expected_revision: 1 },
    context,
  )) as { status: string; errorCode?: string };
  assert.equal(selfApprove.status, "error");
  assert.equal(selfApprove.errorCode, "team_plan_approve_gate");

  // submit → review_pending;模型输出必须带「等待批准、不得动工」提示。
  const submitted = (await teamPlanToolEntry.handler(
    { team_name: "plan-b", operation: "submit", expected_revision: 1 },
    context,
  )) as { status: string; plan?: { state: string; revision: number } };
  assert.equal(submitted.status, "ok");
  assert.equal(submitted.plan?.state, "review_pending");
  const submitText = teamPlanToolEntry.formatModelContent?.(submitted);
  assert.match(submitText ?? "", /awaiting user approval/i);
  assert.match(submitText ?? "", /Do NOT start work/i);

  // 批准走 TeamPlanApprove:输出 launchPlan 实例化剧本(v2.8 templatePlan 同构)。
  const approved = (await teamPlanApproveToolEntry.handler(
    { team_name: "plan-b", operation: "approve", expected_revision: 2 },
    context,
  )) as { status: string; launchPlan?: string[]; plan?: { state: string; approvedAt?: string } };
  assert.equal(approved.status, "ok");
  assert.equal(approved.plan?.state, "approved");
  assert.ok(approved.plan?.approvedAt !== undefined);
  const launch = approved.launchPlan ?? [];
  assert.ok(launch.some((line) => line.includes("Spawn members via Agent")));
  assert.ok(launch.some((line) => line.includes("Split store.ts") && line.includes("backend")));

  // TeamPlanApprove 只接受 approve。
  const wrongOp = (await teamPlanApproveToolEntry.handler(
    { team_name: "plan-b", operation: "get" },
    context,
  )) as { status: string; errorCode?: string };
  assert.equal(wrongOp.status, "error");
  assert.equal(wrongOp.errorCode, "team_plan_approve_gate");
}

test("team plan validation: owner/depends references, dependency cycles, unknown team, reject-revise loop", async () => {
  // 团队不存在时不能起计划:plan.json 与 config.json 同所有权。
  await assert.rejects(
    replaceTeamPlan(teamTest.deps, "plan-missing", { sessionId: "sess_1", members: [MEMBER], tasks: [] }),
    /does not exist/,
  );

  await createTeam("plan-c");

  // owner 不在成员表内。
  await assertRejectsWithCode(
    replaceTeamPlan(teamTest.deps, "plan-c", {
      sessionId: "sess_1",
      members: [MEMBER],
      tasks: [{ id: "t1", subject: "S", owner: "nobody" }],
    }),
    "team_plan_validation",
  );

  // depends 引用不存在的任务 subject。
  await assertRejectsWithCode(
    replaceTeamPlan(teamTest.deps, "plan-c", {
      sessionId: "sess_1",
      members: [MEMBER],
      tasks: [{ id: "t1", subject: "S", depends: ["no such task"] }],
    }),
    "team_plan_validation",
  );

  // 依赖环(a → b → a)在计划期即拒绝。
  await assertRejectsWithCode(
    replaceTeamPlan(teamTest.deps, "plan-c", {
      sessionId: "sess_1",
      members: [MEMBER],
      tasks: [
        { id: "t1", subject: "A", depends: ["B"] },
        { id: "t2", subject: "B", depends: ["A"] },
      ],
    }),
    "team_plan_validation",
  );

  // 驳回-修订循环:review_pending 下 replace 带 feedback 回到 draft(拒绝语义并入 replace)。
  await replaceTeamPlan(teamTest.deps, "plan-c", { sessionId: "sess_1", members: [MEMBER], tasks: [] });
  await submitTeamPlan(teamTest.deps, "plan-c", { expectedRevision: 1 });
  const revised = await replaceTeamPlan(teamTest.deps, "plan-c", {
    sessionId: "sess_1",
    members: [MEMBER],
    tasks: [TASK],
    expectedRevision: 2,
    feedback: "too few members for the scope",
  });
  assert.equal(revised.state, "draft");
  assert.equal(revised.revision, 3);
  assert.equal(revised.feedback, "too few members for the scope");
  // sessionId 在修订中保持稳定(计划归属会话)。
  assert.equal(revised.sessionId, "sess_1");
});
