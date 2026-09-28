// ============================================================
// Agent Teams - 成员 worktree 隔离（v2.7，对齐 cc-haha worktreePath / pi-subagents）
// ============================================================
//
// 团队开启 useWorktree 时，成员 spawn 即在独立 git worktree 副本工作
// （分支 zcode/<team>/<member>），完成由 lead 按分支合并——多成员并行
// 改同一仓库不再互相踩踏。git 调用收敛在本文件（唯一 IO 边界），
// 其余模块只消费 GitWorktreeInfo。创建失败由调用方降级共享工作区。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface GitWorktreeInfo {
  /** 成员的工作目录（worktree 绝对路径）。 */
  path: string;
  /** 成员工作分支（zcode/<team>/<member>）；完成后 lead 按分支合并。 */
  branch: string;
}

function runGit(repoRoot: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: repoRoot });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}

/**
 * 为成员创建独立 worktree：git worktree add -b zcode/<team>/<member> <path>。
 * 目录布局：<teamsRoot>/worktrees/<teamName>/<memberName>（与团队数据同域，便于清理）。
 * 先 prune：清理「目录已被删除但注册残留」的历史 worktree（cleanup 只删目录的语义）。
 */
export async function createGitWorktree(input: {
  repoRoot: string;
  teamName: string;
  memberName: string;
  teamsRoot: string;
}): Promise<GitWorktreeInfo> {
  const branch = "zcode/" + input.teamName + "/" + input.memberName;
  const path = join(input.teamsRoot, "worktrees", input.teamName, input.memberName);
  await mkdir(dirname(path), { recursive: true });
  await runGit(input.repoRoot, ["worktree", "prune"]);
  try {
    await runGit(input.repoRoot, ["worktree", "add", "-b", branch, path]);
  } catch (error) {
    // 分支已存在（成员重 spawn）：清掉失败残留目录后复用该分支检出。
    await rm(path, { recursive: true, force: true });
    await runGit(input.repoRoot, ["worktree", "add", path, branch]).catch(() => {
      throw error;
    });
  }
  return { path, branch };
}

/**
 * 团队解散/会话清理：移除该团队全部成员 worktree 工作目录。
 * 成员工作分支保留（lead 合并入口）；git 主仓库的 worktree 注册由下一次
 * createGitWorktree 的 prune 或手动 git worktree prune 兜底（v2.7 已知边界）。
 * macOS 上 rm 返回后目录条目可能短暂残留（后台句柄/FS 延迟删除），
 * 因此重试直至确认消失，给调用方确定性语义。
 */
export async function cleanupTeamWorktrees(teamsRoot: string, teamName: string): Promise<void> {
  const dir = join(teamsRoot, "worktrees", teamName);
  for (let attempt = 0; attempt < 10; attempt++) {
    await rm(dir, { recursive: true, force: true });
    if (!existsSync(dir)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("cleanupTeamWorktrees: directory still exists after retries: " + dir);
}
