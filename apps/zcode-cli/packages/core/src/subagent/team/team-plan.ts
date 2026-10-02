// ============================================================
// Agent Teams - 团队计划存储（plan.json，计划-审批-启动 v2.10）
// ============================================================
//
// specs/agent-teams.md v2.10：TeamCreate 之后、Agent spawn 之前，lead 用 TeamPlan
// 提交完整团队草案（成员 + 任务 + 依赖）。状态机：
//   draft → review_pending → approved；cancelled 为终态
// 约定：
//   - plan.json 落 `<team-dir>/plan.json`，与 config/tasks 同所有权（runtime 唯一写入者）；
//   - revision 从 1 起，每次成功写 +1；
//   - 全部写入走 withTeamFileLock + 原子写（tmp → rename）；
//   - replace/submit/approve 需 expectedRevision CAS，防并发覆盖；
//   - approve 仅 review_pending 可进（人类权限面在 TeamPlanApprove 工具的确认窗，
//     存储层只校验状态，不假设调用者身份）。

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  TeamPlanRecordSchema,
  type TeamPlanMember,
  type TeamPlanRecord,
  type TeamPlanTask,
} from "@zcode/contracts";
import type { TeamWorkspaceDirs } from "./team-paths.js";
import { isSafeTeamPathSegment } from "./team-paths.js";
import { readTextFileSafe } from "./team-json-file.js";
import { withTeamFileLock } from "./team-lock.js";
import { loadTeamFile, TeamStoreError } from "./team-store.js";

const PLAN_ATOMIC_TMP_SUFFIX = ".tmp";

export type TeamPlanErrorCode =
  | "team_plan_not_found"
  | "team_plan_conflict"
  | "team_plan_locked"
  | "team_plan_not_review_pending"
  | "team_plan_invalid_state"
  | "team_plan_validation";

export class TeamPlanStoreError extends Error {
  readonly code: TeamPlanErrorCode;

  constructor(code: TeamPlanErrorCode, message: string) {
    super(message);
    this.name = "TeamPlanStoreError";
    this.code = code;
  }
}

/** 与 TeamStoreDeps 同构：读写 plan.json 所需的最小目录描述；tests 注入临时目录构造。 */
export interface TeamPlanDeps {
  dirs: TeamWorkspaceDirs;
}

// -----------------------------------------------
// 读写原语
// -----------------------------------------------

async function loadPlanRecord(deps: TeamPlanDeps, teamName: string): Promise<TeamPlanRecord | undefined> {
  const raw = await readTextFileSafe(deps.dirs.teamPlanFile(teamName));
  if (raw === undefined) return undefined;
  return parsePlanRecord(raw, teamName);
}

function parsePlanRecord(raw: string, teamName: string): TeamPlanRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Team plan for ${teamName} is not valid JSON: ${(error as Error).message}`);
  }
  const result = TeamPlanRecordSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Team plan for ${teamName} failed schema validation: ${result.error.message}`);
  }
  // teamName 绑定防止 plan.json 被挪到别的团队目录后被当作同一份事实。
  if (result.data.teamName !== teamName) {
    throw new Error(`Team plan file is inconsistent with team ${teamName}`);
  }
  return result.data;
}

async function savePlanRecord(deps: TeamPlanDeps, teamName: string, record: TeamPlanRecord): Promise<void> {
  const planFile = deps.dirs.teamPlanFile(teamName);
  await mkdir(dirname(planFile), { recursive: true });
  const tmpFile = join(dirname(planFile), `plan.json${PLAN_ATOMIC_TMP_SUFFIX}`);
  await writeFile(tmpFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(tmpFile, planFile);
}

function assertSafeTeamName(teamName: string): void {
  if (!isSafeTeamPathSegment(teamName)) {
    throw new TeamStoreError("team_invalid_name", `Invalid team name: ${teamName}`, teamName);
  }
}

// -----------------------------------------------
// 读
// -----------------------------------------------

/** 读取当前计划；不存在返回 undefined（业务层据此给出 team_plan_not_found）。 */
export async function readTeamPlan(deps: TeamPlanDeps, teamName: string): Promise<TeamPlanRecord | undefined> {
  assertSafeTeamName(teamName);
  return loadPlanRecord(deps, teamName);
}

// -----------------------------------------------
// 状态机守卫
// -----------------------------------------------

async function requirePlan(deps: TeamPlanDeps, teamName: string): Promise<TeamPlanRecord> {
  const plan = await loadPlanRecord(deps, teamName);
  if (plan === undefined) {
    throw new TeamPlanStoreError("team_plan_not_found", `No plan exists for team ${teamName}`);
  }
  return plan;
}

/** approved/cancelled 为终态：任何修改入口先拒绝（team_plan_locked），再看 CAS。 */
function assertNotLocked(plan: TeamPlanRecord, operation: string): void {
  if (plan.state === "approved" || plan.state === "cancelled") {
    throw new TeamPlanStoreError(
      "team_plan_locked",
      `Team plan for ${plan.teamName} is ${plan.state} (revision ${plan.revision}); ${operation} is not allowed`,
    );
  }
}

function assertRevisionMatches(plan: TeamPlanRecord, expectedRevision: number | undefined, operation: string): void {
  if (expectedRevision === undefined) {
    throw new TeamPlanStoreError(
      "team_plan_conflict",
      `${operation} requires expected_revision (current revision ${plan.revision}); read the plan first`,
    );
  }
  if (expectedRevision !== plan.revision) {
    throw new TeamPlanStoreError(
      "team_plan_conflict",
      `Team plan revision conflict for ${plan.teamName}: expected ${expectedRevision}, current ${plan.revision}`,
    );
  }
}

// -----------------------------------------------
// 计划引用校验（owner → member.name；depends → 计划内任务 subject）
// -----------------------------------------------

function assertPlanReferences(members: readonly TeamPlanMember[], tasks: readonly TeamPlanTask[]): void {
  const duplicateNames = findDuplicates(members.map((member) => member.name));
  if (duplicateNames.length > 0) {
    throw new TeamPlanStoreError("team_plan_validation", `Duplicate member names in plan: ${duplicateNames.join(", ")}`);
  }
  const duplicateIds = findDuplicates(members.map((member) => member.id));
  if (duplicateIds.length > 0) {
    throw new TeamPlanStoreError("team_plan_validation", `Duplicate member ids in plan: ${duplicateIds.join(", ")}`);
  }
  const duplicateTaskIds = findDuplicates(tasks.map((task) => task.id));
  if (duplicateTaskIds.length > 0) {
    throw new TeamPlanStoreError("team_plan_validation", `Duplicate task ids in plan: ${duplicateTaskIds.join(", ")}`);
  }
  // depends 引用任务 subject 作为计划内自然语言键，subject 必须唯一且存在。
  const duplicateSubjects = findDuplicates(tasks.map((task) => task.subject));
  if (duplicateSubjects.length > 0) {
    throw new TeamPlanStoreError("team_plan_validation", `Duplicate task subjects in plan: ${duplicateSubjects.join(", ")}`);
  }
  const memberNames = new Set(members.map((member) => member.name));
  for (const task of tasks) {
    if (task.owner !== undefined && !memberNames.has(task.owner)) {
      throw new TeamPlanStoreError(
        "team_plan_validation",
        `Task "${task.subject}" owner "${task.owner}" does not match any planned member`,
      );
    }
    for (const dependency of task.depends ?? []) {
      if (dependency === task.subject) {
        throw new TeamPlanStoreError("team_plan_validation", `Task "${task.subject}" depends on itself`);
      }
      if (!tasks.some((candidate) => candidate.subject === dependency)) {
        throw new TeamPlanStoreError(
          "team_plan_validation",
          `Task "${task.subject}" depends on unknown task subject "${dependency}"`,
        );
      }
    }
  }
  assertNoDependencyCycles(tasks);
}

/** 依赖环会让团队永久卡死，计划期即拒绝。 */
function assertNoDependencyCycles(tasks: readonly TeamPlanTask[]): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const bySubject = new Map(tasks.map((task) => [task.subject, task] as const));
  const visit = (subject: string, path: readonly string[]): void => {
    if (visited.has(subject)) return;
    if (visiting.has(subject)) {
      throw new TeamPlanStoreError(
        "team_plan_validation",
        `Task dependency cycle in plan: ${[...path, subject].join(" -> ")}`,
      );
    }
    visiting.add(subject);
    const task = bySubject.get(subject);
    for (const dependency of task?.depends ?? []) visit(dependency, [...path, subject]);
    visiting.delete(subject);
    visited.add(subject);
  };
  for (const task of tasks) visit(task.subject, []);
}

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

// -----------------------------------------------
// 写操作（持锁 + CAS）
// -----------------------------------------------

export interface ReplaceTeamPlanParams {
  /** 计划归属会话；创建时写入 record，此后稳定不变。 */
  sessionId: string;
  members: TeamPlanMember[];
  tasks: TeamPlanTask[];
  /** 计划已存在时必填且须等于当前 revision；不存在时必须缺席（否则视为陈旧视图的 CAS 冲突）。 */
  expectedRevision?: number;
  /** 驳回意见（用户在确认窗拒绝后，lead 修订时回填；反馈循环的 reject 语义并入 replace）。 */
  feedback?: string;
}

/**
 * 全量替换计划：不存在则创建 draft revision 1；draft/review_pending 下可改（驳回-修订循环
 * 会回到 draft）；approved/cancelled 后拒绝（team_plan_locked）。每次成功写 revision +1。
 */
export async function replaceTeamPlan(
  deps: TeamPlanDeps,
  teamName: string,
  params: ReplaceTeamPlanParams,
): Promise<TeamPlanRecord> {
  assertSafeTeamName(teamName);
  const planFile = deps.dirs.teamPlanFile(teamName);
  return withTeamFileLock(planFile, async () => {
    const existing = await loadPlanRecord(deps, teamName);
    if (existing === undefined) {
      // CAS 基线：计划不存在却带着 expected_revision，说明客户端看到过别处的历史版本，拒绝。
      if (params.expectedRevision !== undefined) {
        throw new TeamPlanStoreError(
          "team_plan_conflict",
          `No plan exists for team ${teamName} but expected revision ${params.expectedRevision}; retry without expected_revision to create`,
        );
      }
      // plan.json 与 config.json 同目录同所有权：团队必须先经 TeamCreate 建立。
      const team = await loadTeamFile(deps, teamName);
      if (team === undefined) {
        throw new TeamStoreError("team_io_error", `Team ${teamName} does not exist`, teamName);
      }
      assertPlanReferences(params.members, params.tasks);
      const created: TeamPlanRecord = {
        schemaVersion: 1,
        teamName,
        sessionId: params.sessionId,
        revision: 1,
        state: "draft",
        members: params.members,
        tasks: params.tasks,
        ...(params.feedback === undefined ? {} : { feedback: params.feedback }),
      };
      await savePlanRecord(deps, teamName, created);
      return created;
    }
    assertNotLocked(existing, "replace");
    assertRevisionMatches(existing, params.expectedRevision, "replace");
    assertPlanReferences(params.members, params.tasks);
    // feedback 反映最近一次 replace 的输入（含驳回意见），不带即清空。
    const { feedback: _previousFeedback, ...rest } = existing;
    const revised: TeamPlanRecord = {
      ...rest,
      revision: existing.revision + 1,
      state: "draft",
      members: params.members,
      tasks: params.tasks,
      ...(params.feedback === undefined ? {} : { feedback: params.feedback }),
    };
    await savePlanRecord(deps, teamName, revised);
    return revised;
  });
}

/** draft → review_pending：提交等待用户批准。此后 lead 不得动工（工具描述层约束）。 */
export async function submitTeamPlan(
  deps: TeamPlanDeps,
  teamName: string,
  params: { expectedRevision: number },
): Promise<TeamPlanRecord> {
  assertSafeTeamName(teamName);
  const planFile = deps.dirs.teamPlanFile(teamName);
  return withTeamFileLock(planFile, async () => {
    const existing = await requirePlan(deps, teamName);
    assertNotLocked(existing, "submit");
    assertRevisionMatches(existing, params.expectedRevision, "submit");
    if (existing.state !== "draft") {
      throw new TeamPlanStoreError(
        "team_plan_invalid_state",
        `Team plan for ${teamName} is ${existing.state}; only draft plans can be submitted`,
      );
    }
    const submitted: TeamPlanRecord = {
      ...existing,
      revision: existing.revision + 1,
      state: "review_pending",
    };
    await savePlanRecord(deps, teamName, submitted);
    return submitted;
  });
}

/**
 * review_pending → approved：批准事实落盘并盖 approvedAt 时间戳。批准动作本身必须来自
 * 人类权限面（TeamPlanApprove 确认窗）；存储层只保证仅 review_pending 可进。
 */
export async function approveTeamPlan(
  deps: TeamPlanDeps,
  teamName: string,
  params: { expectedRevision: number },
): Promise<TeamPlanRecord> {
  assertSafeTeamName(teamName);
  const planFile = deps.dirs.teamPlanFile(teamName);
  return withTeamFileLock(planFile, async () => {
    const existing = await requirePlan(deps, teamName);
    assertNotLocked(existing, "approve");
    assertRevisionMatches(existing, params.expectedRevision, "approve");
    if (existing.state !== "review_pending") {
      throw new TeamPlanStoreError(
        "team_plan_not_review_pending",
        `Team plan for ${teamName} is ${existing.state}; submit it for review before approving`,
      );
    }
    const approved: TeamPlanRecord = {
      ...existing,
      revision: existing.revision + 1,
      state: "approved",
      approvedAt: new Date().toISOString(),
    };
    await savePlanRecord(deps, teamName, approved);
    return approved;
  });
}
