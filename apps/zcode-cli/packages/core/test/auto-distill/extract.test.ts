// 规则式候选提取单测（specs/auto-distill.md 验收场景 1 的提取半链路）：
// - 固定会话样本 → 候选：重复命令（围栏 / $ 前缀 / 行内代码三种来源、跨会话加成）、
//   被采纳修复（连续 assistant 修复叙述 + 用户确认语；无确认不产出）。
// - 确定性：同输入两次提取结果完全一致（含 id 与 createdAt）；置信度落在 (0, 0.9]。
// - 噪声：普通散文、白名单外首 token、只出现一次的命令都不产出候选。
// fixture 全部为虚构脱敏数据。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test apps/zcode-cli/packages/core/test/auto-distill/extract.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import { extractDistillCandidates } from "../../src/auto-distill/extract.js";
import type { DistillSessionInput } from "../../src/auto-distill/types.js";

// ── 脱敏合成 fixture ─────────────────────────────────────────

const FIXED_NOW = () => new Date("2026-01-02T08:00:00.000Z");

const SESSION_ALPHA: DistillSessionInput = {
  sessionId: "sess-alpha",
  fragments: [
    { role: "user", text: "帮我检查一下类型" },
    {
      role: "assistant",
      text: "好的，运行类型检查和 lint：\n```bash\npnpm typecheck\npnpm lint\n```",
    },
  ],
};

const SESSION_BETA: DistillSessionInput = {
  sessionId: "sess-beta",
  fragments: [
    { role: "user", text: "再跑一次检查" },
    { role: "assistant", text: "执行 `$ pnpm typecheck` 全部通过。" },
  ],
};

const FIX_SESSION: DistillSessionInput = {
  sessionId: "sess-fix",
  fragments: [
    { role: "user", text: "桌面窗口打不开了" },
    {
      role: "assistant",
      text: "定位到根因：窗口生命周期里未初始化就调用 show。我修复了该时序问题，先 ensureReady 再 show。",
    },
    { role: "user", text: "好的，完美" },
  ],
};

// ── 重复命令 ──────────────────────────────────────────────────

test("重复命令跨两个会话产出候选，含跨会话置信度加成", () => {
  const candidates = extractDistillCandidates([SESSION_ALPHA, SESSION_BETA], { now: FIXED_NOW });
  const command = candidates.find((candidate) => candidate.kind === "repeated-command");
  assert.ok(command, "应产出 pnpm typecheck 候选");
  assert.match(command.summary, /pnpm typecheck/u);
  assert.match(command.summary, /2 次/u);
  assert.match(command.summary, /2 个会话/u);
  // 来源会话 = 首次出现所在会话（spec：每候选必带来源会话 id）。
  assert.equal(command.sourceSessionId, "sess-alpha");
  assert.equal(command.confidence, 0.7); // 0.55 基础 + 0.15 跨会话
  assert.equal(command.createdAt, "2026-01-02T08:00:00.000Z");
  // 只出现一次的命令不产出候选。
  assert.equal(
    candidates.some((candidate) => candidate.summary.includes("pnpm lint")),
    false,
  );
});

test("同一会话内重复两次的命令产出候选，无跨会话加成", () => {
  const session: DistillSessionInput = {
    sessionId: "sess-repeat",
    fragments: [
      { role: "user", text: "跑测试" },
      { role: "assistant", text: "```\nnpm test\n```\n再补一次 `npm test` 确认稳定。" },
    ],
  };
  const candidates = extractDistillCandidates([session], { now: FIXED_NOW });
  const command = candidates.find((candidate) => candidate.kind === "repeated-command");
  assert.ok(command, "围栏与行内代码来源应都计入同一命令");
  assert.equal(command.confidence, 0.55);
  assert.equal(command.sourceSessionId, "sess-repeat");
});

// ── 被采纳的修复 ──────────────────────────────────────────────

test("修复叙述后跟用户确认语产出被采纳修复候选", () => {
  const candidates = extractDistillCandidates([FIX_SESSION], { now: FIXED_NOW });
  const fix = candidates.find((candidate) => candidate.kind === "adopted-fix");
  assert.ok(fix, "应产出修复候选");
  assert.equal(fix.sourceSessionId, "sess-fix");
  assert.equal(fix.confidence, 0.7); // 0.6 基础 + 0.1 根因表述
  // 摘要取修复叙述的首句，自包含可直接进审阅列表。
  assert.equal(fix.summary, "定位到根因：窗口生命周期里未初始化就调用 show。");
});

test("修复叙述后用户未确认（继续追问）不产出候选", () => {
  const session: DistillSessionInput = {
    sessionId: "sess-nofix",
    fragments: [
      { role: "user", text: "构建失败了" },
      { role: "assistant", text: "我修复了构建脚本里的路径问题，请再试一次。" },
      { role: "user", text: "我觉得还是不对，请你再看看有没有其他原因" },
    ],
  };
  assert.deepEqual(extractDistillCandidates([session], { now: FIXED_NOW }), []);
});

test("连续多条修复回复合并为单条候选并加连续分", () => {
  const session: DistillSessionInput = {
    sessionId: "sess-chain",
    fragments: [
      { role: "user", text: "类型检查报错了" },
      { role: "assistant", text: "我先看下报错来源。" },
      { role: "assistant", text: "已解决：tsconfig 的 paths 少了一条别名映射，现已修复。" },
      { role: "user", text: "对，就是这样" },
    ],
  };
  const fixes = extractDistillCandidates([session], { now: FIXED_NOW }).filter(
    (candidate) => candidate.kind === "adopted-fix",
  );
  assert.equal(fixes.length, 1);
  // 0.6 基础 + 0.05 连续 assistant（无根因词）。
  assert.equal(fixes[0].confidence, 0.65);
  assert.equal(fixes[0].summary, "已解决：tsconfig 的 paths 少了一条别名映射，现已修复。");
});

test("确认语出现在下一轮 assistant 回复之后，不属于上一轮修复", () => {
  const session: DistillSessionInput = {
    sessionId: "sess-late",
    fragments: [
      { role: "user", text: "修一下 lint" },
      { role: "assistant", text: "我修复了 lint 报错的两个规则，已通过检查。" },
      { role: "assistant", text: "另外补充了对应的单测。" },
      { role: "user", text: "新的报错又出现了" },
      { role: "assistant", text: "这个是另一个问题，我继续排查。" },
      { role: "user", text: "好的" },
    ],
  };
  assert.deepEqual(extractDistillCandidates([session], { now: FIXED_NOW }), []);
});

// ── 确定性与噪声 ──────────────────────────────────────────────

test("同输入两次提取结果完全一致，输出按置信度降序", () => {
  const sessions = [SESSION_ALPHA, SESSION_BETA, FIX_SESSION];
  const first = extractDistillCandidates(sessions, { now: FIXED_NOW });
  const second = extractDistillCandidates(sessions, { now: FIXED_NOW });
  assert.deepEqual(first, second);
  assert.ok(first.length >= 2);
  for (let index = 1; index < first.length; index += 1) {
    assert.ok(first[index - 1].confidence >= first[index].confidence);
  }
  for (const candidate of first) {
    assert.ok(candidate.confidence > 0 && candidate.confidence <= 0.9);
    assert.match(candidate.id, /^distill-(repeated-command|adopted-fix)-[0-9a-f]{12}$/u);
  }
});

test("散文与非白名单首 token 不产出候选", () => {
  const session: DistillSessionInput = {
    sessionId: "sess-noise",
    fragments: [
      { role: "user", text: "我现在要运行测试了看看结果" },
      {
        role: "assistant",
        text: "输出如下：\n```\nfoo bar baz qux\ncompilation finished\n```\n见上。",
      },
    ],
  };
  assert.deepEqual(extractDistillCandidates([session], { now: FIXED_NOW }), []);
});
