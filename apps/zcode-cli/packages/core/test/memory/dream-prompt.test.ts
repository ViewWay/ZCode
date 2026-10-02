// /dream 内置命令单测：命令解析与巩固提示词构建（参考 cc-haha consolidationPrompt）。

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDreamPrompt } from "../../src/memory/dream-prompt.js";
import { parseDreamCommand } from "../../src/runtime/helpers/commands.js";

test("parseDreamCommand mirrors /compact semantics", () => {
  assert.equal(parseDreamCommand("/dream"), undefined);
  assert.equal(parseDreamCommand("  /dream  "), undefined);
  assert.equal(parseDreamCommand("/dream 刷新团队记忆"), "刷新团队记忆");
  assert.equal(parseDreamCommand("/dream "), undefined);
  assert.equal(parseDreamCommand("/dreamx"), null);
  assert.equal(parseDreamCommand("do something"), null);
});

test("buildDreamPrompt embeds memory root and focus instructions", () => {
  const prompt = buildDreamPrompt({
    memoryRoot: "/home/u/.zcode/mem",
    workspaceRoot: "/work/demo",
    instructions: "团队记忆优先",
  });
  assert.ok(prompt.includes("# Dream: Memory Consolidation"));
  assert.ok(prompt.includes("`/home/u/.zcode/mem/`"));
  assert.ok(prompt.includes("`/work/demo`"));
  assert.ok(prompt.includes("## Focus\n\n团队记忆优先"));
  assert.ok(!prompt.includes("not enabled"));
});

test("buildDreamPrompt degrades gracefully without memory root", () => {
  const prompt = buildDreamPrompt({ memoryRoot: undefined });
  assert.ok(prompt.includes("requires project memory"));
  assert.ok(!prompt.includes("Phase 1"));
});
