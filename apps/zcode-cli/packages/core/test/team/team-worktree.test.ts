// worktree 隔离端到端单测：单 test 顺序执行全部场景（消除多 test 并发对 git CLI 的干扰）

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupTeamWorktrees, createGitWorktree } from "../../src/subagent/team/team-worktree.js";

function initTempRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "wt-repo-"));
  execFileSync("git", ["init"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repoRoot });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoRoot });
  return repoRoot;
}

test("worktree isolation: create on own branch, re-spawn reuses branch, cleanup removes dir", async () => {
  const repoRoot = initTempRepo();
  const teamsRoot = mkdtempSync(join(tmpdir(), "wt-teams-"));

  // 场景 1：首次 spawn 创建独立分支与副本
  const alice = await createGitWorktree({ repoRoot, teamName: "demo", memberName: "alice", teamsRoot });
  assert.equal(alice.branch, "zcode/demo/alice");
  assert.ok(existsSync(alice.path));

  // 场景 2：清理移除工作目录（分支保留），重 spawn 复用已有分支（bob）
  await cleanupTeamWorktrees(teamsRoot, "demo");
  assert.equal(existsSync(alice.path), false);
  const bob = await createGitWorktree({ repoRoot, teamName: "demo", memberName: "bob", teamsRoot });
  assert.equal(bob.branch, "zcode/demo/bob");
  assert.ok(existsSync(bob.path));

  // 场景 3：同名成员重 spawn（分支已存在 + 目录已被清理）→ prune 后复用分支重新检出
  await cleanupTeamWorktrees(teamsRoot, "demo");
  const aliceAgain = await createGitWorktree({ repoRoot, teamName: "demo", memberName: "alice", teamsRoot });
  assert.equal(aliceAgain.branch, "zcode/demo/alice");
  assert.ok(existsSync(aliceAgain.path));

  await cleanupTeamWorktrees(teamsRoot, "demo");
});
