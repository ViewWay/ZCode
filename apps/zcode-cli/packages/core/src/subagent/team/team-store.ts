// ============================================================
// Agent Teams - TeamFile 存储层（磁盘事实源，runtime 唯一写入者）
// ============================================================
//
// specs/agent-teams.md 存储约定：
//   `<home>/.zcode/teams/<workspace-key>/<team-name>/config.json`
// 写入一律「持锁 + 原子写（tmp → rename）」；并发创建走 withConfigWrite 互斥区，
// 幂等语义（同名团队返回 existing）在锁内判定，避免双写竞态。

import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  TeamFileSchema,
  TEAM_LEAD_MEMBER_NAME,
  TEAM_MAX_MEMBERS,
  type TeamFile,
  type TeamMember,
} from "@zcode/contracts";
import type { TeamWorkspaceDirs } from "./team-paths.js";
import { isSafeTeamPathSegment } from "./team-paths.js";
import { readTextFileSafe } from "./team-json-file.js";
import { withTeamFileLock } from "./team-lock.js";

const CONFIG_FILE_NAME = "config.json";
const ATOMIC_WRITE_SUFFIX = ".tmp";

export type TeamStoreErrorCode = "team_invalid_name" | "team_io_error";

export class TeamStoreError extends Error {
  readonly code: TeamStoreErrorCode;
  readonly teamName?: string;

  constructor(code: TeamStoreErrorCode, message: string, teamName?: string) {
    super(message);
    this.name = "TeamStoreError";
    this.code = code;
    this.teamName = teamName;
  }
}

export class TeamMemberLimitError extends Error {
  readonly teamName: string;
  readonly limit: number;

  constructor(teamName: string) {
    super(`Team ${teamName} already reached the member limit (${TEAM_MAX_MEMBERS})`);
    this.name = "TeamMemberLimitError";
    this.teamName = teamName;
    this.limit = TEAM_MAX_MEMBERS;
  }
}

/** 读写 TeamFile 所需的最小目录描述；tests 注入临时目录构造。 */
export interface TeamStoreDeps {
  dirs: TeamWorkspaceDirs;
}

export async function loadTeamFile(deps: TeamStoreDeps, teamName: string): Promise<TeamFile | undefined> {
  assertSafeTeamName(teamName);
  const raw = await readTextFileSafe(deps.dirs.teamConfigFile(teamName));
  if (raw === undefined) return undefined;
  return parseTeamFile(raw, teamName);
}

/** 枚举该 workspace 的全部团队名（目录名即团队名；无 config.json 的残目录忽略）。 */
export async function listTeamNames(deps: TeamStoreDeps): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(deps.dirs.teamsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const team = await loadTeamFile(deps, entry.name);
    if (team) names.push(team.name);
  }
  return names.sort((left, right) => left.localeCompare(right));
}

/**
 * v1 共享任务列表的团队解析规则：workspace 恰有一个团队时直接使用；
 * 零个/多个团队时要求调用方先收敛（TeamCreate 或 TeamDelete），避免在工具入参里
 * 再引入一个可漂移的 team 选择器。多团队显式选择留给后续带 team 参数的协议扩展。
 */
export async function resolveSingleTeamName(deps: TeamStoreDeps): Promise<string> {
  const names = await listTeamNames(deps);
  if (names.length === 0) {
    throw new TeamStoreError("team_io_error", "No team exists in this workspace; call TeamCreate first");
  }
  if (names.length > 1) {
    throw new TeamStoreError(
      "team_io_error",
      `Multiple teams exist in this workspace (${names.join(", ")}); disband extras before using shared tasks`,
    );
  }
  return names[0]!;
}

export interface CreateTeamParams {
  name: string;
  description?: string;
  leadAgentId: string;
  leadSessionId?: string;
  leadWorkingDirectory: string;
  now?: () => Date;
}

/**
 * 幂等创建：TeamFile 已存在时返回 `{ team, status: "existing" }`，不覆盖任何字段。
 * 创建（含存在性判定）整个发生在文件锁内，两个并发 TeamCreate 不可能双写。
 */
export async function createOrGetTeam(
  deps: TeamStoreDeps,
  params: CreateTeamParams,
): Promise<{ team: TeamFile; status: "created" | "existing" }> {
  assertSafeTeamName(params.name);
  const configFile = deps.dirs.teamConfigFile(params.name);
  return withTeamFileLock(configFile, async () => {
      const existingRaw = await readTextFileSafe(configFile);
    if (existingRaw !== undefined) {
      return { team: parseTeamFile(existingRaw, params.name), status: "existing" as const };
    }
    const now = (params.now ?? (() => new Date()))().toISOString();
    const leadMember: TeamMember = {
      agentId: params.leadAgentId,
      name: TEAM_LEAD_MEMBER_NAME,
      cwd: params.leadWorkingDirectory,
      isActive: true,
      joinedAt: now,
      ...(params.leadSessionId === undefined ? {} : { sessionId: params.leadSessionId }),
    };
    const team: TeamFile = {
      name: params.name,
      createdAt: now,
      leadAgentId: params.leadAgentId,
      members: [leadMember],
      ...(params.description === undefined ? {} : { description: params.description }),
      ...(params.leadSessionId === undefined ? {} : { leadSessionId: params.leadSessionId }),
    };
    await writeTeamFileAtomic(configFile, team);
    return { team, status: "created" as const };
  });
}

/** 锁内读改写 TeamFile；updater 抛错则不落盘。返回 updater 的结果。 */
export async function updateTeamFile<T>(
  deps: TeamStoreDeps,
  teamName: string,
  updater: (team: TeamFile) => Promise<{ value: T; team: TeamFile }> | { value: T; team: TeamFile },
): Promise<T> {
  assertSafeTeamName(teamName);
  const configFile = deps.dirs.teamConfigFile(teamName);
  return withTeamFileLock(configFile, async () => {
      const raw = await readTextFileSafe(configFile);
    if (raw === undefined) {
      throw new TeamStoreError("team_io_error", `Team ${teamName} does not exist`, teamName);
    }
    const current = parseTeamFile(raw, teamName);
    const { value, team } = await updater(current);
    await writeTeamFileAtomic(configFile, team);
    return value;
  });
}

export interface JoinTeamParams {
  member: TeamMember;
  /** 幂等保护：同名 teammate 重复 spawn 必须报错，不覆盖（AC2）。 */
  allowExisting?: false;
}

/** 注册 teammate 成员；同名成员已存在时抛错（不覆盖）。 */
export async function addTeamMember(deps: TeamStoreDeps, teamName: string, member: TeamMember): Promise<TeamFile> {
  return updateTeamFile(deps, teamName, (team) => {
    if (team.members.some((candidate) => candidate.name === member.name)) {
      throw new TeamStoreError(
        "team_io_error",
        `Teammate "${member.name}" already exists in team ${teamName}`,
        teamName,
      );
    }
    if (team.members.length >= TEAM_MAX_MEMBERS) {
      throw new TeamMemberLimitError(teamName);
    }
    return { value: { ...team, members: [...team.members, member] }, team: { ...team, members: [...team.members, member] } };
  });
}

export async function removeTeamMember(deps: TeamStoreDeps, teamName: string, memberName: string): Promise<void> {
  await updateTeamFile(deps, teamName, (team) => {
    const members = team.members.filter((candidate) => candidate.name !== memberName);
    const next = { ...team, members };
    return { value: undefined, team: next };
  });
}

/** 成员状态变化（isActive）以 TeamFile 为准落盘，供 roster 只读发现。 */
export async function setTeamMemberActive(
  deps: TeamStoreDeps,
  teamName: string,
  memberName: string,
  isActive: boolean,
): Promise<void> {
  await updateTeamFile(deps, teamName, (team) => {
    const members = team.members.map((candidate) =>
      candidate.name === memberName ? { ...candidate, isActive } : candidate,
    );
    return { value: undefined, team: { ...team, members } };
  });
}

export interface DeleteTeamResult {
  deleted: boolean;
}

/** 删除整个团队目录（TeamFile + mailbox + tasks + locks）。目录不存在视为幂等成功。 */
export async function deleteTeamDir(deps: TeamStoreDeps, teamName: string): Promise<DeleteTeamResult> {
  assertSafeTeamName(teamName);
  const teamDir = deps.dirs.teamDir(teamName);
  try {
    await rm(teamDir, { recursive: true, force: false });
    return { deleted: true };
  } catch (error) {
    if (isEnoent(error)) return { deleted: false };
    throw error;
  }
}

async function writeTeamFileAtomic(targetFile: string, team: TeamFile): Promise<void> {
  await mkdir(dirname(targetFile), { recursive: true });
  const tmpFile = join(dirname(targetFile), `${CONFIG_FILE_NAME}${ATOMIC_WRITE_SUFFIX}`);
  await writeFile(tmpFile, `${JSON.stringify(team, null, 2)}\n`, "utf8");
  await rename(tmpFile, targetFile);
}

function parseTeamFile(raw: string, teamName: string): TeamFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TeamStoreError(
      "team_io_error",
      `TeamFile for ${teamName} is not valid JSON: ${(error as Error).message}`,
      teamName,
    );
  }
  const result = TeamFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new TeamStoreError(
      "team_io_error",
      `TeamFile for ${teamName} failed schema validation: ${result.error.message}`,
      teamName,
    );
  }
  return result.data;
}

function assertSafeTeamName(teamName: string): void {
  if (!isSafeTeamPathSegment(teamName)) {
    throw new TeamStoreError("team_invalid_name", `Invalid team name: ${teamName}`, teamName);
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
