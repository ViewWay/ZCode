// 项目记忆目录定位（与 core 侧 runtime memory 同一公式）。
// 从 apps/zcode-cli/packages/core/src/memory/project-root.ts 迁入 shared：
// 自动沉淀"确认"动作在 Desktop host 进程写项目记忆（specs/auto-distill.md），
// 而 packages 不能依赖 apps；放 shared/node 保证 CLI runtime 与 Desktop 审阅面
// 用同一份实现计算目录，不会因两份公式漂移写散记忆。
// core 原文件改为本实现的再导出（见 core/src/memory/project-root.ts）。

import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";

interface ProjectMemoryRootInput {
  cliStorageRoot: string;
  workspaceIdentity?: string;
  workspacePath: string;
}

export function resolveProjectMemoryRoot(input: ProjectMemoryRootInput): string {
  const workspaceIdentity = input.workspaceIdentity?.trim();
  const normalizedWorkspacePath = resolve(input.workspacePath);
  const keySource =
    workspaceIdentity ||
    (process.platform === "win32"
      ? normalizedWorkspacePath.toLowerCase()
      : normalizedWorkspacePath);
  const hash = createHash("sha256").update(keySource).digest("hex").slice(0, 16);
  const slug = workspaceIdentity
    ? "project"
    : sanitizeProjectSlug(basename(normalizedWorkspacePath) || "project");

  return join(input.cliStorageRoot, "memories", "projects", `${slug}-${hash}`, "memory");
}

function sanitizeProjectSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "project";
}
