// /evolve 内置命令单测：命令解析与三主体自进化提示词构建（参考 MiMo evolve-seed）。

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildEvolvePrompt } from "../../src/evolve/evolve-prompt.js";
import { parseEvolveCommand } from "../../src/runtime/helpers/commands.js";

test("parseEvolveCommand mirrors /dream semantics", () => {
  assert.equal(parseEvolveCommand("/evolve"), undefined);
  assert.equal(parseEvolveCommand("  /evolve  "), undefined);
  assert.equal(parseEvolveCommand("/evolve 团队方向校准"), "团队方向校准");
  assert.equal(parseEvolveCommand("/evolve "), undefined);
  assert.equal(parseEvolveCommand("/evolvex"), null);
  assert.equal(parseEvolveCommand("/evolve "), undefined);
  assert.equal(parseEvolveCommand("do something"), null);
});

test("buildEvolvePrompt embeds workspace and growth log paths", () => {
  const prompt = buildEvolvePrompt({
    workspaceRoot: "/work/demo",
    memoryRoot: "/home/u/.zcode/mem",
    instructions: "团队方向校准",
  });
  assert.ok(prompt.includes("# Evolve: Session Self-Evolution Cycle"));
  assert.ok(prompt.includes("`/work/demo/.zcode/evolve/GROWTH.md`"));
  assert.ok(prompt.includes("`/home/u/.zcode/mem/`"));
  assert.ok(prompt.includes("## Focus\n\n团队方向校准"));
  assert.ok(prompt.includes("git -C /work/demo log"));
});

test("buildEvolvePrompt degrades gracefully without workspace", () => {
  const prompt = buildEvolvePrompt({ workspaceRoot: undefined });
  assert.ok(prompt.includes("requires an open workspace"));
  assert.ok(!prompt.includes("Phase 1"));
});
