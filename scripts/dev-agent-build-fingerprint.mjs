// ============================================================
// dev agent CLI 构建输入指纹（specs/desktop-dev-performance.md 改动一）
// ============================================================
//
// build-desktop-agent-cli.mjs 默认路径每次启动无条件重建 11 个 workspace
// （实测 30.8s），是 dev 启动慢的大头。本模块用「输入 stat 指纹」判断能否
// 跳过重建：输入未变 + dist 入口在场 → 跳过重建，只做暂存。
//
// 事实源与所有权：stamp 文件（node_modules/.cache/zcode-dev-agent-build/
// stamp.json）是唯一持久事实，由本模块独占读写；构建脚本只在全量构建成功
// 后写 stamp。指纹未命中时绝不写 stamp（避免半次构建留下有效指纹）。
//
// 指纹输入（specs AC-P3）：ZCODE_ENV / ZCODE_DESKTOP_AGENT_BUILD_MODE /
// ZCODE_BOOTSTRAP_WITH_REMOTE 三个环境变量 + pnpm-lock.yaml + 各纳管
// workspace 的 tsconfig 与 src 树 stat（相对路径 + size + mtimeMs）。

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** 纳管构建输入的 workspace（与 build-desktop-agent-cli.mjs 的构建清单同源）。 */
const FINGERPRINT_WORKSPACES = [
  "apps/zcode-cli/packages/shared-types",
  "apps/zcode-cli/packages/contracts",
  "apps/zcode-cli/packages/dynamic-workflow",
  "apps/zcode-cli/packages/dynamic-workflow-runtime",
  "apps/zcode-cli/packages/core",
  "apps/zcode-cli/packages/adapters",
  "apps/zcode-cli/packages/i18n",
  "apps/zcode-cli/packages/telemetry",
  "apps/zcode-cli/packages/bootstrap",
  "apps/zcode-cli/packages/node-repl-host",
  "apps/zcode-cli/packages/browser-use-plugin",
];

/** 构建产物随这些环境变量变化，必须进指纹（specs AC-P3）。 */
const FINGERPRINT_ENV_KEYS = [
  "ZCODE_ENV",
  "ZCODE_DESKTOP_AGENT_BUILD_MODE",
  "ZCODE_BOOTSTRAP_WITH_REMOTE",
];

const STAMP_DIR = "node_modules/.cache/zcode-dev-agent-build";
const STAMP_FILE = `${STAMP_DIR}/stamp.json`;
/** dist 入口：跳过重建前必须确认在场（防半次构建的残缺 dist 命中指纹）。 */
const BUNDLE_ENTRY = "apps/zcode-cli/packages/cli/dist/zcode.cjs";

/**
 * 评估指纹门：返回 `{ skip, fingerprint }`。
 * skip=true 表示输入未变且 dist 在场，构建脚本可跳过重建只做暂存。
 */
export async function evaluateFingerprintGate(repoRoot) {
  const fingerprint = await collectFingerprint(repoRoot);
  if (process.env.ZCODE_DESKTOP_AGENT_FORCE_BUILD === "1") {
    return { skip: false, fingerprint };
  }
  const stamp = await readStamp(repoRoot);
  if (stamp === undefined || stamp.fingerprint !== fingerprint) {
    return { skip: false, fingerprint };
  }
  if (!existsSync(resolve(repoRoot, BUNDLE_ENTRY))) {
    // dist 缺失（手动清理等）：输入虽未变也不允许跳过，防残缺产物命中指纹。
    return { skip: false, fingerprint };
  }
  return { skip: true, fingerprint };
}

/** 全量构建成功后调用；skip 路径绝不写 stamp。 */
export async function saveFingerprintStamp(repoRoot, fingerprint) {
  const stampFile = resolve(repoRoot, STAMP_FILE);
  await mkdir(resolve(repoRoot, STAMP_DIR), { recursive: true });
  await writeFile(
    stampFile,
    `${JSON.stringify({ fingerprint, writtenAt: new Date().toISOString() })}\n`,
  );
}

async function readStamp(repoRoot) {
  try {
    const raw = await readFile(resolve(repoRoot, STAMP_FILE), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.fingerprint === "string" ? { fingerprint: parsed.fingerprint } : undefined;
  } catch {
    return undefined;
  }
}

/** stat 指纹：相对路径 + size + mtimeMs，纯 stat 不读内容（几千文件 < 100ms 量级）。 */
async function collectFingerprint(repoRoot) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(Object.fromEntries(FINGERPRINT_ENV_KEYS.map((key) => [key, process.env[key] ?? ""]))));
  hash.update(await statLine(join(repoRoot, "pnpm-lock.yaml"), "pnpm-lock.yaml"));
  for (const workspace of FINGERPRINT_WORKSPACES) {
    hash.update(await collectWorkspaceFingerprint(repoRoot, workspace));
  }
  return hash.digest("hex");
}

async function collectWorkspaceFingerprint(repoRoot, workspace) {
  const workspaceRoot = resolve(repoRoot, workspace);
  const label = workspace.replace(/^.*packages\//, "");
  const parts = [];
  parts.push(await statLine(join(workspaceRoot, "tsconfig.json"), `${label}/tsconfig.json`));
  const srcDir = join(workspaceRoot, "src");
  if (existsSync(srcDir)) {
    parts.push(await walkTree(srcDir, label, ""));
  }
  return parts.join("");
}

async function walkTree(dir, label, prefix) {
  let out = "";
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out += await walkTree(join(dir, entry.name), label, rel);
      continue;
    }
    out += await statLine(join(dir, entry.name), `${label}/${rel}`);
  }
  return out;
}

async function statLine(path, label) {
  try {
    const info = await stat(path);
    return `${label}|${info.size}|${Math.round(info.mtimeMs)}\n`;
  } catch {
    return `${label}|missing\n`;
  }
}
