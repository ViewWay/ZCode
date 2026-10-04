// 已沉淀知识审阅服务单测（specs/auto-distill.md 验收场景 2 的确认半链路）：
// - list：直接透出 store.list（排序语义归 store）。
// - confirm：候选移交恰好一次；确定性记忆文件落在 resolveProjectMemoryRoot 的项目记忆
//   目录（与 core memory agent 同目录），frontmatter 为 recall 可读格式；重复确认
//   status=missing 不再写；写失败/缺工作区时候选补偿回列表（所有权未移交）。
// - delete：只删候选；promote：SKILL.md 草稿落注入的用户技能根目录。
// fixture 全部为虚构脱敏数据。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test packages/services/test/auto-distill/distillKnowledgeService.test.ts

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import type { DistillCandidate } from "@zcode/shared";
import { createDistillCandidateStore } from "@zcode/shared/node";

import { createDistillKnowledgeService } from "../../src/auto-distill/distillKnowledgeService.js";

function baseCandidate(overrides: Partial<DistillCandidate> = {}): DistillCandidate {
  return {
    id: "distill-repeated-command-abc123def456",
    kind: "repeated-command",
    summary: "高频命令：`pnpm verify:pre-push`（出现 3 次，跨 2 个会话）",
    sourceSessionId: "sess-9f",
    confidence: 0.75,
    createdAt: "2026-10-01T08:00:00.000Z",
    workspace: { path: "/repos/zcode" },
    ...overrides,
  };
}

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-distill-svc-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** fake store：覆盖 list/confirm/delete/promote 的移交语义，不触文件系统（promote 单测另走真实 store）。 */
function fakeStore(initial: readonly DistillCandidate[]) {
  const candidates = new Map(initial.map((candidate) => [candidate.id, candidate]));
  const calls = { confirm: [] as string[] };
  const store = {
    calls,
    list: async () =>
      [...candidates.values()].sort((left, right) => right.confidence - left.confidence),
    add: async (incoming: readonly DistillCandidate[]) => {
      for (const candidate of incoming) candidates.set(candidate.id, candidate);
    },
    confirm: async (candidateId: string) => {
      calls.confirm.push(candidateId);
      const candidate = candidates.get(candidateId);
      if (!candidate) return undefined;
      candidates.delete(candidateId);
      return candidate;
    },
    delete: async (candidateId: string) => candidates.delete(candidateId),
    promote: async (candidateId: string, input: { skillsRootDir: string }) => {
      const candidate = candidates.get(candidateId);
      if (!candidate) return undefined;
      candidates.delete(candidateId);
      return {
        skillFilePath: path.join(input.skillsRootDir, "distill-fake-skill", "SKILL.md"),
        candidate,
      };
    },
  };
  return store;
}

test("list 透出 store 的候选（置信度降序由 store 保证）", async () => {
  const store = fakeStore([
    baseCandidate({ id: "distill-low", confidence: 0.55 }),
    baseCandidate({ id: "distill-high", confidence: 0.9 }),
  ]);
  const service = createDistillKnowledgeService({ store });
  const listed = await service.list();
  assert.deepEqual(
    listed.map((candidate) => candidate.id),
    ["distill-high", "distill-low"],
  );
});

test("confirm 恰好写一条 recall 可读的项目记忆文件并删除候选", async () => {
  await withTempDir(async (root) => {
    const candidate = baseCandidate();
    const store = fakeStore([candidate]);
    const service = createDistillKnowledgeService({ store, cliStorageRoot: root });

    const outcome = await service.confirm(candidate.id);
    assert.equal(outcome.status, "confirmed");
    assert.ok(outcome.memoryFilePath);

    // 文件落在 <cliStorageRoot>/memories/projects/<slug>-<hash>/memory/ 下，
    // 文件名确定性（候选 id）→ 重复确认重写同一文件，仍恰好一条。
    const relative = path.relative(root, outcome.memoryFilePath!);
    assert.match(relative, /^memories[/\\]projects[/\\]zcode-[a-f0-9]{16}[/\\]memory[/\\]/u);
    assert.ok(outcome.memoryFilePath!.endsWith(`${candidate.id}.md`));

    const content = await readFile(outcome.memoryFilePath!, "utf8");
    assert.ok(content.startsWith("---\n"));
    const frontmatterEnd = content.indexOf("\n---", 4);
    const frontmatter = parseYaml(content.slice(4, frontmatterEnd)) as {
      description: string;
      metadata: { node_type: string; type: string; originSessionId: string };
    };
    assert.equal(frontmatter.description, candidate.summary);
    assert.equal(frontmatter.metadata.node_type, "memory");
    assert.equal(frontmatter.metadata.type, "project");
    assert.equal(frontmatter.metadata.originSessionId, candidate.sourceSessionId);

    // 候选已从待审列表消失；重复确认幂等返回 missing，不再产生写入。
    assert.deepEqual(await store.list(), []);
    const repeat = await service.confirm(candidate.id);
    assert.equal(repeat.status, "missing");
  });
});

test("confirm 候选缺工作区时补偿回列表并抛可读错误（不静默丢数据）", async () => {
  const candidate = baseCandidate({ workspace: undefined });
  const store = fakeStore([candidate]);
  const service = createDistillKnowledgeService({ store, cliStorageRoot: "/tmp/unused" });

  await assert.rejects(service.confirm(candidate.id), /来源工作区/u);
  // 所有权未移交：候选仍在待审列表。
  assert.equal((await store.list()).length, 1);
});

test("confirm 记忆写失败时候选补偿回列表（下次确认可重试）", async () => {
  await withTempDir(async (root) => {
    const candidate = baseCandidate();
    const store = fakeStore([candidate]);
    // cliStorageRoot 指向一个普通文件：mkdir memories/projects 必失败，模拟落盘故障。
    const blockedRoot = path.join(root, "blocked");
    await writeFile(blockedRoot, "not-a-dir", "utf8");
    const service = createDistillKnowledgeService({ store, cliStorageRoot: blockedRoot });

    await assert.rejects(service.confirm(candidate.id));
    assert.equal((await store.list()).length, 1, "写失败后候选应回到待审列表");
  });
});

test("delete 只删候选，不产生任何记忆写入", async () => {
  const candidate = baseCandidate();
  const store = fakeStore([candidate]);
  const service = createDistillKnowledgeService({ store });

  assert.equal(await service.delete(candidate.id), true);
  assert.equal(await service.delete(candidate.id), false);
  assert.deepEqual(await store.list(), []);
});

test("promote 把 SKILL.md 草稿落到注入的用户技能根目录", async () => {
  await withTempDir(async (root) => {
    // promote 走真实 store（tmpdir）验证服务的 skillsRootDir 接线，fake 不覆盖文件语义。
    const distillRootDir = path.join(root, "distill");
    const store = createDistillCandidateStore({ distillRootDir });
    const candidate = baseCandidate({
      id: "distill-adopted-fix-promote01",
      kind: "adopted-fix",
      summary: "已解决：tsconfig paths 缺别名，补齐后 typecheck 恢复。",
    });
    await store.add([candidate]);
    const skillsRootDir = path.join(root, "skills");
    const service = createDistillKnowledgeService({ store, skillsRootDir });

    const promoted = await service.promote(candidate.id);
    assert.ok(promoted);
    assert.ok(promoted.skillFilePath.startsWith(skillsRootDir));
    const content = await readFile(promoted.skillFilePath, "utf8");
    assert.match(content, /## 适用场景/u);
    assert.deepEqual(await store.list(), []);
    assert.equal(await service.promote(candidate.id), undefined);
  });
});

test("candidates.json 损坏时 list 抛出的错误带可读原因（UI 失败态数据源）", async () => {
  await withTempDir(async (root) => {
    const distillRootDir = path.join(root, "distill");
    await mkdir(distillRootDir, { recursive: true });
    await writeFile(path.join(distillRootDir, "candidates.json"), "{broken", "utf8");
    const store = createDistillCandidateStore({ distillRootDir });
    const service = createDistillKnowledgeService({ store });

    await assert.rejects(service.list(), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("candidates.json") && message.includes("不是合法 JSON");
    });
  });
});
