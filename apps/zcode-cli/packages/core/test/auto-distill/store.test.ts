// 候选存储单测（specs/auto-distill.md 验收场景 2 的存储半链路；tmpdir 真实读写，不 mock 文件系统）：
// - add/list：按置信度降序；同 id upsert 不重复；落盘内容可被新 store 实例读到。
// - confirm：恰好移交一次数据（重复 confirm 返回 undefined → 模拟 memory 恰好写一条）；候选从文件删除。
// - delete：不产生任何数据移交（删除不触 memory 写入）。
// - promote：SKILL.md 草稿落盘（YAML frontmatter 可解析、含来源信息），候选删除，重复 promote 幂等。
// - 边界：损坏 candidates.json 抛稳定错误码；homeDir / distillRootDir 注入生效；非法候选拒绝写入。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test apps/zcode-cli/packages/core/test/auto-distill/store.test.ts

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import {
  createDistillCandidateStore,
  DISTILL_CANDIDATES_FILE_CORRUPT_ERROR_CODE,
  DistillCandidatesFileError,
} from "../../src/auto-distill/store.js";
import type { DistillCandidate } from "../../src/auto-distill/types.js";

// ── 合成 fixture ─────────────────────────────────────────────

let sequence = 0;

function candidate(overrides: Partial<DistillCandidate> = {}): DistillCandidate {
  sequence += 1;
  return {
    id: `distill-repeated-command-${String(sequence).padStart(12, "0")}`,
    kind: "repeated-command",
    summary: `高频命令：\`pnpm check-${sequence}\`（出现 2 次）`,
    sourceSessionId: `sess-${sequence}`,
    confidence: 0.6,
    createdAt: "2026-01-02T08:00:00.000Z",
    ...overrides,
  };
}

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-distill-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ── add / list ───────────────────────────────────────────────

test("add 后 list 按置信度降序，重新打开 store 仍能读到落盘内容", async () => {
  await withTempDir(async (root) => {
    const distillRootDir = path.join(root, "distill");
    const store = createDistillCandidateStore({ distillRootDir });
    await store.add([
      candidate({ id: "distill-low", confidence: 0.55 }),
      candidate({ id: "distill-high", confidence: 0.85 }),
      candidate({ id: "distill-mid", confidence: 0.7 }),
    ]);

    const reopened = createDistillCandidateStore({ distillRootDir });
    assert.deepEqual(
      (await reopened.list()).map((entry) => entry.id),
      ["distill-high", "distill-mid", "distill-low"],
    );
  });
});

test("同 id add 幂等 upsert，不产生重复条目", async () => {
  await withTempDir(async (root) => {
    const store = createDistillCandidateStore({ distillRootDir: path.join(root, "distill") });
    const first = candidate({ id: "distill-same", confidence: 0.6 });
    const second = { ...first, confidence: 0.75 };
    await store.add([first]);
    await store.add([second]);

    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].confidence, 0.75);
  });
});

test("非法候选（置信度越界 / 空 id）在 add 时被拒绝且不落盘", async () => {
  await withTempDir(async (root) => {
    const store = createDistillCandidateStore({ distillRootDir: path.join(root, "distill") });
    await assert.rejects(store.add([candidate({ confidence: 1.5 })]));
    await assert.rejects(store.add([candidate({ id: "" })]));
    assert.deepEqual(await store.list(), []);
  });
});

// ── confirm / delete（memory 写入幂等） ───────────────────────

test("confirm 恰好移交一次数据，重复 confirm 返回 undefined", async () => {
  await withTempDir(async (root) => {
    const distillRootDir = path.join(root, "distill");
    const store = createDistillCandidateStore({ distillRootDir });
    await store.add([
      candidate({ id: "distill-confirm", confidence: 0.8 }),
      candidate({ id: "distill-other", confidence: 0.5 }),
    ]);

    // 模拟调用方复用既有 memory 写入路径：只有拿到移交数据才写一条。
    const memoryWrites: DistillCandidate[] = [];
    const first = await store.confirm("distill-confirm");
    if (first) memoryWrites.push(first);
    const second = await store.confirm("distill-confirm");
    if (second) memoryWrites.push(second);

    assert.equal(memoryWrites.length, 1);
    assert.equal(second, undefined);
    assert.deepEqual(
      (await store.list()).map((entry) => entry.id),
      ["distill-other"],
    );
    // 文件内容同步收敛：候选已从 candidates.json 删除（所有权移交 memory）。
    const raw = JSON.parse(await readFile(path.join(distillRootDir, "candidates.json"), "utf8"));
    assert.deepEqual(
      raw.candidates.map((entry: { id: string }) => entry.id),
      ["distill-other"],
    );
  });
});

test("delete 只删候选，不产生任何数据移交", async () => {
  await withTempDir(async (root) => {
    const store = createDistillCandidateStore({ distillRootDir: path.join(root, "distill") });
    await store.add([candidate({ id: "distill-del", confidence: 0.7 })]);

    assert.equal(await store.delete("distill-del"), true);
    assert.equal(await store.delete("distill-del"), false);
    // 已删除的候选再 confirm 也拿不到数据 → 不会触发 memory 写入。
    assert.equal(await store.confirm("distill-del"), undefined);
    assert.deepEqual(await store.list(), []);
  });
});

// ── promote（提升为技能草稿） ─────────────────────────────────

test("promote 生成 SKILL.md 草稿并删除候选，重复 promote 幂等", async () => {
  await withTempDir(async (root) => {
    const store = createDistillCandidateStore({ distillRootDir: path.join(root, "distill") });
    const target = candidate({
      id: "distill-promote",
      kind: "adopted-fix",
      summary: "已解决：tsconfig 的 paths 少了一条别名映射，现已修复。",
      confidence: 0.75,
    });
    await store.add([target]);

    const skillsRootDir = path.join(root, "skills");
    const promoted = await store.promote("distill-promote", { skillsRootDir });
    assert.ok(promoted, "应完成提升");
    assert.ok(promoted.skillFilePath.startsWith(skillsRootDir));
    assert.ok(promoted.skillFilePath.endsWith("SKILL.md"));

    const content = await readFile(promoted.skillFilePath, "utf8");
    assert.ok(content.startsWith("---\n"));
    const frontmatterEnd = content.indexOf("\n---", 4);
    const frontmatter = parseYaml(content.slice(4, frontmatterEnd)) as Record<string, string>;
    assert.equal(frontmatter.description, target.summary);
    assert.match(frontmatter.name, /^distill-[a-z0-9._-]+$/u);
    assert.match(content, /## 来源/u);
    assert.match(content, new RegExp(target.sourceSessionId, "u"));
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.promote("distill-promote", { skillsRootDir }), undefined);
  });
});

// ── 边界与注入 ───────────────────────────────────────────────

test("损坏的 candidates.json 抛稳定错误码", async () => {
  await withTempDir(async (root) => {
    const distillRootDir = path.join(root, "distill");
    await mkdir(distillRootDir, { recursive: true });
    await writeFile(path.join(distillRootDir, "candidates.json"), "{oops", "utf8");
    const store = createDistillCandidateStore({ distillRootDir });
    await assert.rejects(
      store.list(),
      (error: unknown) =>
        error instanceof DistillCandidatesFileError &&
        error.code === DISTILL_CANDIDATES_FILE_CORRUPT_ERROR_CODE,
    );

    // schema 版本不符同样按损坏处理。
    await writeFile(
      path.join(distillRootDir, "candidates.json"),
      JSON.stringify({ version: 99, candidates: [] }),
      "utf8",
    );
    await assert.rejects(store.list(), DistillCandidatesFileError);
  });
});

test("homeDir 注入时候选落在 <homeDir>/.zcode/distill/candidates.json", async () => {
  await withTempDir(async (root) => {
    const homeDir = path.join(root, "home");
    const store = createDistillCandidateStore({ homeDir });
    await store.add([candidate({ id: "distill-home", confidence: 0.6 })]);

    const raw = JSON.parse(
      await readFile(path.join(homeDir, ".zcode", "distill", "candidates.json"), "utf8"),
    );
    assert.equal(raw.version, 1);
    assert.equal(raw.candidates.length, 1);
  });
});
