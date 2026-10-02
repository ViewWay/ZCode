// ============================================================
// 外部会话 transcript 路径边界
// ============================================================
// 外部会话工具只允许读 ~/.claude/projects（specs/external-sessions.md 的
// 工具内部白名单）。所有实际访问的路径在打开前必须通过本模块校验：
// 1. path.resolve 归一化后用 path.relative 做前缀校验（跨平台，不手写分隔符）；
// 2. 两侧 realpath 后再做一次前缀校验，拒绝目录内符号链接指向边界外
//    （防符号链接逃逸）。
// 边界外路径抛带可读信息的 Error，由调用方向上冒泡。

import { realpath } from "node:fs/promises";
import path from "node:path";

export const CLAUDE_CONFIG_DIR_NAME = ".claude";
export const CLAUDE_PROJECTS_DIR_NAME = "projects";

/** 解析外部会话根目录：<homeDir>/.claude/projects（homeDir 由调用方注入或取 os.homedir()）。 */
export function resolveExternalSessionsRoot(homeDir: string): string {
  return path.resolve(homeDir, CLAUDE_CONFIG_DIR_NAME, CLAUDE_PROJECTS_DIR_NAME);
}

/**
 * 校验 candidate 位于 root 之内（含 root 自身），越界抛错。
 * 返回值无意义；纯校验函数，便于在每次 open/readdir 前统一调用。
 */
export async function assertPathWithinRoot(root: string, candidate: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (!isWithinDirectory(resolvedRoot, resolvedCandidate)) {
    throw new Error(
      `External session path rejected: outside ~/.claude/projects boundary (${resolvedCandidate})`,
    );
  }
  // 第二段防线：realpath 展开符号链接后再校验一次。
  // candidate 不存在（枚举后又被删除的竞态）时让 ENOENT 按读取错误向上冒泡。
  const realRoot = await realpath(resolvedRoot);
  const realCandidate = await realpath(resolvedCandidate);
  if (!isWithinDirectory(realRoot, realCandidate)) {
    throw new Error(
      `External session path rejected: symlink escape from ~/.claude/projects (${resolvedCandidate})`,
    );
  }
}

/**
 * 判断 candidate 是否位于 dir 之内（含 dir 自身）。
 * 用 path.relative 而非字符串前缀比较，天然跨平台；`..` 只按路径段匹配，
 * 避免把目录名形如 "..foo" 的合法子路径误判为越界。
 */
function isWithinDirectory(dir: string, candidate: string): boolean {
  const relative = path.relative(dir, candidate);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}
