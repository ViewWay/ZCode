// ============================================================
// Agent Teams - 团队存储路径解析（只读侧；specs/agent-teams.md）
// ============================================================
//
// 与 agent runtime 的 team-paths.ts（apps/zcode-cli/packages/core/src/subagent/team/）
// 保持同一目录约定：`<home>/.zcode/teams/<workspace-key>/<team-name>/config.json`。
// 两侧分属不同 pnpm workspace（@zcode/services 与 @zcode/contracts 无法互相引用），
// 因此这里按同构实现并靠单测钉住样例哈希向量；任何一侧改算法必须同步另一侧，
// 否则 roster 会静默指向空目录。

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const WORKSPACE_KEY_HASH_CHARS = 12;

export type TeamsHomeDirResolver = () => string;

const DEFAULT_HOME_DIR_RESOLVER: TeamsHomeDirResolver = () => homedir();

/** 团队存储根：`<home>/.zcode/teams`。 */
export function resolveTeamsRoot(homeDirResolver: TeamsHomeDirResolver = DEFAULT_HOME_DIR_RESOLVER): string {
  return join(homeDirResolver(), ".zcode", "teams");
}

/** Agent Teams 的身份归一规则：identity 优先，路径兜底（AGENTS.md Workspace Identity）。 */
export function resolveTeamsIdentityKey(input: {
  workspaceIdentity?: string;
  workspacePath: string;
}): string {
  const identity = input.workspaceIdentity?.trim();
  return identity && identity.length > 0 ? identity : input.workspacePath;
}

/** 身份键 → workspace-key（sha256 前 12 hex）；与 runtime `resolveWorkspaceKey` 同构。 */
export function resolveTeamsWorkspaceKey(identityKey: string): string {
  return createHash("sha256").update(identityKey, "utf8").digest("hex").slice(
    0,
    WORKSPACE_KEY_HASH_CHARS,
  );
}

/** 该 workspace 的团队根目录（其下每个子目录即一个团队）。 */
export function resolveTeamsWorkspaceDir(
  input: { workspaceIdentity?: string; workspacePath: string },
  homeDirResolver: TeamsHomeDirResolver = DEFAULT_HOME_DIR_RESOLVER,
): string {
  return join(resolveTeamsRoot(homeDirResolver), resolveTeamsWorkspaceKey(resolveTeamsIdentityKey(input)));
}
