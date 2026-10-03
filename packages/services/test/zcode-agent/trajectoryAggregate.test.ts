// aggregateModelUsageStats 单测：跨会话聚合（fixture 目录注入，不依赖真实 ~/.zcode）。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { aggregateModelUsageStats } from "../../src/zcode-agent/modelTrajectory.js";

function makeFixtureDir(): { dir: string; write: (name: string, lines: string[]) => void } {
  const dir = mkdtempSync(join(tmpdir(), "zcode-traj-"));
  return {
    dir,
    write: (name, lines) => writeFileSync(join(dir, name), lines.join("\n") + "\n", "utf8"),
  };
}

const REC = (
  model: string,
  tool: string,
  tokens: number,
  opts: { error?: boolean; startedAt?: string } = {},
) =>
  JSON.stringify({
    type: "model_io",
    model: { providerId: "p1", modelId: model },
    request: { toolNames: [tool] },
    response: { usage: { inputTokens: tokens, outputTokens: tokens / 2 } },
    ...(opts.error ? { error: { code: "x", message: "boom" } } : {}),
    ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
  });

test("聚合：按模型/工具统计调用与 token", async () => {
  const fixture = makeFixtureDir();
  fixture.write("model-io-s1.jsonl", [
    REC("glm-5.3", "Bash", 100),
    REC("glm-5.3", "Read", 200),
    REC("glm-5.3-flash", "Bash", 50),
  ]);
  const stats = await aggregateModelUsageStats({ dirs: [fixture.dir] });
  assert.equal(stats.scannedRecords, 3);
  assert.equal(stats.totalInputTokens, 350);
  assert.deepEqual(
    stats.byModel.map((m) => m.modelId),
    ["glm-5.3", "glm-5.3-flash"],
  );
  assert.deepEqual(
    stats.byTool.map((t) => t.tool),
    ["Bash", "Read"],
  );
});

test("聚合：错误计数与 sinceMs 过滤", async () => {
  const fixture = makeFixtureDir();
  fixture.write("model-io-s2.jsonl", [
    REC("glm-5.3", "Bash", 100),
    REC("glm-5.3", "Edit", 100, { error: true, startedAt: "2026-10-03T00:00:00.000Z" }),
  ]);
  const all = await aggregateModelUsageStats({ dirs: [fixture.dir] });
  assert.equal(all.erroredRecords, 1);
  const recent = await aggregateModelUsageStats({
    dirs: [fixture.dir],
    sinceMs: Date.parse("2026-09-01T00:00:00.000Z"),
  });
  assert.equal(recent.scannedRecords, 1);
  assert.equal(recent.erroredRecords, 1);
});

test("聚合：损坏行跳过；无目录返回空统计", async () => {
  const fixture = makeFixtureDir();
  fixture.write("model-io-bad.jsonl", ["{ broken", REC("glm-5.3", "Bash", 10)]);
  const stats = await aggregateModelUsageStats({ dirs: [fixture.dir] });
  assert.equal(stats.scannedRecords, 1);
  const empty = await aggregateModelUsageStats({ dirs: [join(tmpdir(), "zcode-nope")] });
  assert.equal(empty.scannedRecords, 0);
  assert.equal(empty.byTool.length, 0);
});
