// ============================================================
// Agent Teams 存储层测试共享夹具（node:test + tsx）
// ============================================================
// 运行：cd apps/zcode-cli/packages/core && node_modules/.bin/tsx --test test/team/

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";

import {
  resolveTeamWorkspaceDirs,
  type TeamWorkspaceDirs,
} from "../../src/subagent/team/team-paths.js";
import type { TeamStoreDeps } from "../../src/subagent/team/team-store.js";

let homeDir: string;
let dirs: TeamWorkspaceDirs;
let deps: TeamStoreDeps;

before(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "zcode-teams-test-"));
  dirs = resolveTeamWorkspaceDirs({ workspacePath: "/workspaces/demo" }, () => homeDir);
  deps = { dirs };
});

after(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

export interface TeamTestContext {
  homeDir: string;
  dirs: TeamWorkspaceDirs;
  deps: TeamStoreDeps;
  /** 独立 homeDir 的临时 deps（用完自行 rm）。 */
  isolated(): Promise<{ deps: TeamStoreDeps; cleanup(): Promise<void> }>;
}

export const teamTest: TeamTestContext = {
  get homeDir() {
    return homeDir;
  },
  get dirs() {
    return dirs;
  },
  get deps() {
    return deps;
  },
  async isolated() {
    const soloHome = await mkdtemp(join(tmpdir(), "zcode-teams-solo-"));
    const soloDeps: TeamStoreDeps = {
      dirs: resolveTeamWorkspaceDirs({ workspacePath: "/workspaces/solo" }, () => soloHome),
    };
    return {
      deps: soloDeps,
      cleanup: () => rm(soloHome, { recursive: true, force: true }),
    };
  },
};
