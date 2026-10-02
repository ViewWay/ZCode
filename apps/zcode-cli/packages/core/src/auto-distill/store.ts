// 候选存储（specs/auto-distill.md）：~/.zcode/distill/candidates.json 是候选的
// 唯一事实源与唯一写入点。本文件职责边界：
// - 原子写：同目录临时文件 + rename（同卷原子替换）；Windows 上 rename 可能被
//   杀毒/索引器短暂占用，只在该平台做小步重试。
// - 进程内串行化：所有读改写共享一条 promise 链，避免并发 add/confirm/delete
//   互相丢更新。跨进程互斥 v1 不做（候选只由单一宿主后台任务写入）。
// - confirm 只移交数据：从 candidates.json 删除候选并返回给调用方，由调用方
//   复用 services/core 既有 memory 写入路径落盘（不建第二写入路径）。重复
//   confirm 拿不到数据 → 调用方不会重复写 memory（幂等）。
// - promote 生成 SKILL.md 草稿到注入的技能根目录：只落文件、不改任何启用配置，
//   满足 spec"产出物进入候选位，不直接启用"；技能根目录解析属于接线层。
// 运行测试：cd <repo-root> && ./node_modules/.bin/tsx --test apps/zcode-cli/packages/core/test/auto-distill/store.test.ts

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import {
  DISTILL_CANDIDATES_FILE_NAME,
  DISTILL_STORE_SCHEMA_VERSION,
  type DistillCandidate,
  type DistillCandidateKind,
} from "./types.js";

export const DISTILL_CANDIDATES_FILE_CORRUPT_ERROR_CODE = "DISTILL_CANDIDATES_FILE_CORRUPT";

/** candidates.json 损坏（非法 JSON / 结构不符 / 候选字段非法）时抛出。 */
export class DistillCandidatesFileError extends Error {
  readonly code = DISTILL_CANDIDATES_FILE_CORRUPT_ERROR_CODE;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DistillCandidatesFileError";
  }
}

export interface DistillCandidateStore {
  /** 审阅列表：按置信度降序、同分按创建时间升序。 */
  list(): Promise<DistillCandidate[]>;
  /** 写入候选；同 id upsert（提取重跑同一窗口不产生重复条目）。 */
  add(candidates: readonly DistillCandidate[]): Promise<void>;
  /**
   * 确认候选：从 candidates.json 删除并返回数据，调用方据此写 memory。
   * 候选不存在（已确认/已删除）时返回 undefined → 不会产生第二次写。
   */
  confirm(candidateId: string): Promise<DistillCandidate | undefined>;
  /** 删除候选：只动 candidates.json，不产生任何 memory 数据移交。 */
  delete(candidateId: string): Promise<boolean>;
  /**
   * 提升为技能草稿：在 skillsRootDir 下生成 SKILL.md（frontmatter + 骨架），
   * 并从 candidates.json 删除该候选。候选不存在时返回 undefined。
   */
  promote(
    candidateId: string,
    input: { skillsRootDir: string },
  ): Promise<{ skillFilePath: string; candidate: DistillCandidate } | undefined>;
}

export interface CreateDistillCandidateStoreOptions {
  /** 完整候选目录注入（优先级最高，测试用）。 */
  distillRootDir?: string;
  /** home 目录注入；默认解析 <homeDir>/.zcode/distill，与全局数据根约定一致。 */
  homeDir?: string;
}

export function createDistillCandidateStore(
  options: CreateDistillCandidateStoreOptions = {},
): DistillCandidateStore {
  const distillRootDir =
    options.distillRootDir ?? join(options.homeDir ?? homedir(), ".zcode", "distill");
  const candidatesFilePath = join(distillRootDir, DISTILL_CANDIDATES_FILE_NAME);

  // 进程内互斥队列：读改写操作按提交顺序串行执行，先序失败不阻断后序。
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  async function readCandidates(): Promise<DistillCandidate[]> {
    let raw: string;
    try {
      raw = await readFile(candidatesFilePath, "utf8");
    } catch (error) {
      // 首次运行还没有文件：空列表是正常状态，不是损坏。
      if (isNotFoundError(error)) return [];
      throw error;
    }
    return parseCandidatesFile(raw, candidatesFilePath);
  }

  async function writeCandidates(candidates: readonly DistillCandidate[]): Promise<void> {
    await mkdir(distillRootDir, { recursive: true });
    const payload =
      JSON.stringify({ version: DISTILL_STORE_SCHEMA_VERSION, candidates }, null, 2) + "\n";
    await writeFileAtomic(candidatesFilePath, payload);
  }

  /** 读改写核心：找到并删除指定候选，返回被移除的数据；不存在返回 undefined。 */
  async function removeCandidate(candidateId: string): Promise<DistillCandidate | undefined> {
    const candidates = await readCandidates();
    const index = candidates.findIndex((candidate) => candidate.id === candidateId);
    if (index < 0) return undefined;
    const removed = candidates[index];
    const remaining = candidates.filter((_, position) => position !== index);
    await writeCandidates(remaining);
    return removed;
  }

  return {
    list: () =>
      enqueue(async () =>
        (await readCandidates()).sort(
          (left, right) =>
            right.confidence - left.confidence ||
            left.createdAt.localeCompare(right.createdAt) ||
            left.id.localeCompare(right.id, "en"),
        ),
      ),
    add: (candidates) =>
      enqueue(async () => {
        const byId = new Map(
          (await readCandidates()).map((candidate) => [candidate.id, candidate]),
        );
        for (const candidate of candidates) {
          assertValidCandidate(candidate);
          byId.set(candidate.id, candidate);
        }
        await writeCandidates([...byId.values()]);
      }),
    confirm: (candidateId) => enqueue(() => removeCandidate(candidateId)),
    delete: async (candidateId) =>
      (await enqueue(() => removeCandidate(candidateId))) !== undefined,
    promote: (candidateId, input) =>
      enqueue(async () => {
        const candidates = await readCandidates();
        const candidate = candidates.find((entry) => entry.id === candidateId);
        if (!candidate) return undefined;
        // 先落草稿再删候选：中途失败时候选仍在，重试 promote 幂等（内容确定性相同）。
        const skillFilePath = await writeSkillDraft(candidate, input.skillsRootDir);
        await writeCandidates(candidates.filter((entry) => entry.id !== candidateId));
        return { skillFilePath, candidate };
      }),
  };
}

// ── 文件读写 ───────────────────────────────────────────────────

/** Windows 上 rename 可能被杀毒/索引器短暂锁住，仅该平台小步重试后放弃。 */
const RENAME_RETRY_DELAYS_MS = [10, 30, 60, 100];

async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  // 同目录临时文件 + rename：rename 在同一卷上是原子替换，读者不会看到半截 JSON。
  const temporaryFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryFilePath, contents, "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporaryFilePath, filePath);
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        attempt >= RENAME_RETRY_DELAYS_MS.length ||
        !isTransientRenameError(error)
      ) {
        throw error;
      }
      await delay(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function isTransientRenameError(error: unknown): boolean {
  const code = readErrorCode(error);
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

function isNotFoundError(error: unknown): boolean {
  return readErrorCode(error) === "ENOENT";
}

function readErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

// ── 内容校验 ───────────────────────────────────────────────────

const DISTILL_CANDIDATE_KINDS: readonly DistillCandidateKind[] = [
  "repeated-command",
  "adopted-fix",
];

/** 解析并校验 candidates.json；任何偏差都按损坏抛稳定错误码，不静默丢弃数据。 */
function parseCandidatesFile(raw: string, filePath: string): DistillCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DistillCandidatesFileError(`candidates.json 不是合法 JSON：${filePath}`, {
      cause: error,
    });
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== DISTILL_STORE_SCHEMA_VERSION ||
    !Array.isArray(parsed.candidates)
  ) {
    throw new DistillCandidatesFileError(
      `candidates.json 结构不符合 schema v${DISTILL_STORE_SCHEMA_VERSION}：${filePath}`,
    );
  }
  return parsed.candidates.map((entry, index) => {
    if (!isDistillCandidate(entry)) {
      throw new DistillCandidatesFileError(
        `candidates.json 第 ${index} 条候选字段非法：${filePath}`,
      );
    }
    return entry;
  });
}

/** 写入侧校验：add 的入参必须本来就是合法候选，问题在调用方而非文件。 */
function assertValidCandidate(candidate: DistillCandidate): void {
  // 先取 id：通过类型守卫否定分支后 candidate 会被收窄成 never。
  const candidateId = candidate.id;
  if (!isDistillCandidate(candidate)) {
    throw new Error(`非法的沉淀候选：${candidateId}`);
  }
}

function isDistillCandidate(value: unknown): value is DistillCandidate {
  if (!isRecord(value)) return false;
  const kind = value.kind;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof kind === "string" &&
    (DISTILL_CANDIDATE_KINDS as readonly string[]).includes(kind) &&
    typeof value.summary === "string" &&
    value.summary.length > 0 &&
    typeof value.sourceSessionId === "string" &&
    value.sourceSessionId.length > 0 &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    typeof value.createdAt === "string" &&
    !Number.isNaN(Date.parse(value.createdAt))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── 技能草稿（promote） ────────────────────────────────────────

function buildSkillDraftSlug(candidate: DistillCandidate): string {
  // 目录名只保留 ASCII 安全字符；中文摘要无法转出可用 slug 时回退 id 后缀。
  const slug = candidate.summary
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const idSuffix = candidate.id.slice(-8);
  return slug.length >= 4 ? `distill-${slug}-${idSuffix}` : `distill-${idSuffix}`;
}

async function writeSkillDraft(
  candidate: DistillCandidate,
  skillsRootDir: string,
): Promise<string> {
  const slug = buildSkillDraftSlug(candidate);
  const skillDir = join(skillsRootDir, slug);
  const skillFilePath = join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  const frontmatter = stringifyYaml({ name: slug, description: candidate.summary });
  const body = [
    `# ${candidate.summary}`,
    "",
    "## 来源",
    `- 会话：${candidate.sourceSessionId}`,
    `- 置信度：${candidate.confidence}`,
    `- 沉淀时间：${candidate.createdAt}`,
    "",
    "## 适用场景",
    "（草稿：请补充什么情况下应该使用这条知识。）",
    "",
    "## 内容",
    "（草稿：请把候选沉淀的命令或修复步骤整理成可执行的说明。）",
  ].join("\n");
  await writeFileAtomic(skillFilePath, `---\n${frontmatter}---\n\n${body}\n`);
  return skillFilePath;
}
