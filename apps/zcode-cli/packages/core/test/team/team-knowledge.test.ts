// 团队知识库单测：写入/列表/检索（P2 正反馈：学会并共享）

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  listTeamKnowledge,
  searchTeamKnowledge,
  writeTeamKnowledge,
} from "../../src/subagent/team/team-knowledge.js";
import { teamTest } from "./helpers.js";

test("team knowledge: write, list and search round-trip", async () => {
  const written = await writeTeamKnowledge(teamTest.deps, "refactor-team", {
    slug: "fix-flaky-db-test",
    whenToUse: "When the integration test flakes on CI",
    content: "Root cause: shared table not truncated.\nFix: truncate in beforeEach.",
    author: "alice",
  });
  assert.equal(written.slug, "fix-flaky-db-test");
  assert.equal(written.updated, false);

  // 覆盖语义：再次写入为更新
  const updated = await writeTeamKnowledge(teamTest.deps, "refactor-team", {
    slug: "fix-flaky-db-test",
    whenToUse: "When the integration test flakes",
    content: "Updated steps.",
    author: "alice",
  });
  assert.equal(updated.updated, true);

  const entries = await listTeamKnowledge(teamTest.deps, "refactor-team");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].slug, "fix-flaky-db-test");
  assert.equal(entries[0].author, "alice");

  const hit = await searchTeamKnowledge(teamTest.deps, "refactor-team", { query: "flakes" });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].slug, "fix-flaky-db-test");
  assert.match(hit[0].snippet, /Updated steps|flakes/i);

  const miss = await searchTeamKnowledge(teamTest.deps, "refactor-team", { query: "kubernetes" });
  assert.equal(miss.length, 0);
});

test("team knowledge rejects unsafe slugs", async () => {
  await assert.rejects(
    writeTeamKnowledge(teamTest.deps, "refactor-team", {
      slug: "../escape",
      whenToUse: "x",
      content: "y",
      author: "mallory",
    }),
    /Invalid knowledge slug/,
  );
});
