// 文件锁单测：互斥、超时语义、陈旧锁打破

import assert from "node:assert/strict";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { TeamLockTimeoutError, withTeamFileLock } from "../../src/subagent/team/team-lock.js";

let root: string;

before(async () => {
  root = await mkdtempRoot();
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function mkdtempRoot(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "zcode-team-lock-"));
}

test("withTeamFileLock serializes concurrent writers", async () => {
  const resource = join(root, "lock-probe", "state.json");
  let inside = false;
  let acquisitions = 0;
  const worker = async () =>
    withTeamFileLock(resource, async () => {
      assert.equal(inside, false, "critical section must never overlap");
      inside = true;
      acquisitions += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      inside = false;
    });
  await Promise.all([worker(), worker(), worker()]);
  assert.equal(acquisitions, 3);
});

test("withTeamFileLock times out instead of bypassing a held lock", async () => {
  const resource = join(root, "held-probe", "state.json");
  await withTeamFileLock(resource, async () => {
    await assert.rejects(
      withTeamFileLock(resource, async () => {}, { totalWaitMs: 100 }),
      TeamLockTimeoutError,
    );
  });
});

test("withTeamFileLock breaks stale locks left by dead processes", async () => {
  const resource = join(root, "stale-probe", "state.json");
  await mkdir(join(root, "stale-probe"), { recursive: true });
  const staleLock = `${resource}.lock`;
  const staleTime = new Date(Date.now() - 60_000);
  await writeFile(
    staleLock,
    JSON.stringify({ token: "dead-beef", acquiredAt: staleTime.toISOString() }),
  );
  await utimes(staleLock, staleTime, staleTime);
  const result = await withTeamFileLock(resource, async () => "acquired-after-stale");
  assert.equal(result, "acquired-after-stale");
});

test("withTeamFileLock releases cleanly so the next acquisition succeeds", async () => {
  const resource = join(root, "release-probe", "state.json");
  assert.equal(await withTeamFileLock(resource, async () => "first"), "first");
  assert.equal(await withTeamFileLock(resource, async () => "second"), "second");
});
