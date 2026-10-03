// ============================================================
// Agent Teams - 团队存储路径解析与名字安全校验
// ============================================================
//
// specs/agent-teams.md 的存储约定：团队数据落 `<home>/.zcode/teams/<workspace-key>/<team-name>/`。
// workspace-key 由身份键（workspaceIdentity?.trim() || workspacePath）派生；身份值可能含
// 文件系统非法字符（Windows 盘符、URL、远程 identity），因此目录名使用 sha256 前 12 位 hex
// ——与 repo-wiki 既有目录哈希约定一致，业务层不手写任何新格式。

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { TEAM_NAME_MAX_CHARS, TEAM_NAME_PATTERN } from "@zcode/contracts";

/** 测试注入点；生产恒取 agent 进程所在机器的家目录。 */
export type TeamHomeDirResolver = () => string;

const DEFAULT_HOME_DIR_RESOLVER: TeamHomeDirResolver = () => homedir();

const WORKSPACE_KEY_HASH_CHARS = 12;

/** 团队存储根：`<home>/.zcode/teams`。 */
export function resolveTeamsRoot(homeDirResolver: TeamHomeDirResolver = DEFAULT_HOME_DIR_RESOLVER): string {
  return join(homeDirResolver(), ".zcode", "teams");
}

/** 身份键 → 文件系统安全的 workspace-key（sha256 前 12 hex，稳定且不泄漏路径原文）。 */
export function resolveWorkspaceKey(workspaceKey: string): string {
  return createHash("sha256").update(workspaceKey, "utf8").digest("hex").slice(
    0,
    WORKSPACE_KEY_HASH_CHARS,
  );
}

/** Agent Teams 的身份归一规则：identity 优先，路径兜底（AGENTS.md Workspace Identity 一节）。 */
export function resolveTeamIdentityKey(input: {
  workspaceIdentity?: string;
  workspacePath: string;
}): string {
  const identity = input.workspaceIdentity?.trim();
  return identity && identity.length > 0 ? identity : input.workspacePath;
}

export interface TeamWorkspaceDirs {
  /** 该 workspace 的团队根目录。 */
  teamsRoot: string;
  /** 单个团队的目录：config.json / tasks.json / plan.json / inboxes/ / locks/ 都在这里。 */
  teamDir(teamName: string): string;
  teamConfigFile(teamName: string): string;
  teamTasksFile(teamName: string): string;
  /** 团队计划（v2.10）：与 config/tasks 同所有权的 plan.json。 */
  teamPlanFile(teamName: string): string;
  teamInboxDir(teamName: string): string;
  teamInboxFile(teamName: string, memberName: string): string;
  teamLockDir(teamName: string): string;
}

export function resolveTeamWorkspaceDirs(
  input: { workspaceIdentity?: string; workspacePath: string },
  homeDirResolver: TeamHomeDirResolver = DEFAULT_HOME_DIR_RESOLVER,
): TeamWorkspaceDirs {
  const identityKey = resolveTeamIdentityKey(input);
  const workspaceRoot = join(resolveTeamsRoot(homeDirResolver), resolveWorkspaceKey(identityKey));
  const teamDir = (teamName: string) => join(workspaceRoot, teamName);
  return {
    teamsRoot: workspaceRoot,
    teamDir,
    teamConfigFile: (teamName) => join(teamDir(teamName), "config.json"),
    teamTasksFile: (teamName) => join(teamDir(teamName), "tasks.json"),
    teamPlanFile: (teamName) => join(teamDir(teamName), "plan.json"),
    teamInboxDir: (teamName) => join(teamDir(teamName), "inboxes"),
    teamInboxFile: (teamName, memberName) =>
      join(teamDir(teamName), "inboxes", `${memberName}.json`),
    teamLockDir: (teamName) => join(teamDir(teamName), "locks"),
  };
}

/** Windows 保留设备名（不分大小写、含带扩展名变体）；作为目录/文件名一段时必须拒绝。 */
const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/**
 * 校验团队/成员名可以安全地作为跨平台路径段。
 * 协议 schema 已限字符集与长度；这里补上路径层专属规则（Windows 保留名、路径穿越），
 * 让存储层不依赖调用方一定先过 schema。
 */
export function isSafeTeamPathSegment(value: string, maxLength: number = TEAM_NAME_MAX_CHARS): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > maxLength) return false;
  if (!TEAM_NAME_PATTERN.test(value)) return false;
  if (value !== value.trim()) return false;
  if (value.includes("/") || value.includes("\\")) return false;
  const withoutExtension = value.split(".")[0]?.toLowerCase() ?? "";
  if (WINDOWS_RESERVED_NAMES.has(withoutExtension)) return false;
  return true;
}
