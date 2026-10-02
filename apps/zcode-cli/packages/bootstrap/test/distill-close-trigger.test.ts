// 会话结束触发器单测（specs/auto-distill.md 验收场景 1/3 的触发半链路）：
// - 映射：真实用户输入与 assistant 可见 text 片段按 part 顺序进提取输入；model-only
//   输入、compact 摘要、ignored text、非 Bash 工具、重复 part id 都不进提取器；
//   Bash input.command 注成行内反引号片段（提取器的行内命令信号）。
// - 触发：候选带来源工作区落盘（真实 store + tmpdir）；store.add / messages 失败只记
//   warn 不抛错（验收场景 3）；同会话重复触发被进程内频控挡住。
// fixture 全部为虚构脱敏数据。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test apps/zcode-cli/packages/bootstrap/test/distill-close-trigger.test.ts

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import type {
  MessageInfo,
  MessagePart,
  MessageWithParts,
  SessionId,
  SessionStorePort,
} from "@zcode/contracts";
import type {
  DistillCandidate,
  DistillCandidateStore,
  DistillSessionInput,
} from "@zcode/shared";
import { createDistillCandidateStore } from "@zcode/shared/node";

import {
  mapDurableMessagesToDistillInput,
  runSessionCloseDistillTrigger,
} from "../src/app/distill-close-trigger.js";

const SESSION_ID = "sess-distill-1" as SessionId;
const WORKING_DIRECTORY = "/repos/zcode";

// ── 合成 fixture ─────────────────────────────────────────────

let partSequence = 0;

function userMessage(
  id: string,
  texts: readonly string[],
  overrides: Partial<Extract<MessageInfo, { role: "user" }>> = {},
): MessageWithParts {
  return {
    info: {
      id,
      sessionID: SESSION_ID,
      role: "user",
      time: { created: 1 },
      agent: "main",
      ...overrides,
    },
    parts: texts.map((text) => textPart(text)),
  };
}

function assistantMessage(id: string, parts: readonly MessagePart[]): MessageWithParts {
  return {
    info: {
      id,
      sessionID: SESSION_ID,
      role: "assistant",
      time: { created: 2 },
      parentID: "u0",
      mode: "default",
      agent: "main",
      path: { cwd: WORKING_DIRECTORY, root: WORKING_DIRECTORY },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [...parts],
  };
}

function textPart(text: string, options: { ignored?: boolean } = {}): MessagePart {
  partSequence += 1;
  return {
    id: `p-${partSequence}`,
    sessionID: SESSION_ID,
    messageID: "m",
    type: "text",
    text,
    ...(options.ignored ? { ignored: true } : {}),
  };
}

function bashPart(command: string): MessagePart {
  partSequence += 1;
  return {
    id: `p-${partSequence}`,
    sessionID: SESSION_ID,
    messageID: "m",
    type: "tool",
    callID: `call-${partSequence}`,
    tool: "Bash",
    state: {
      status: "completed",
      input: { command },
      output: "",
      title: "run",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

function fakeSessionStore(messages: readonly MessageWithParts[]): Pick<
  SessionStorePort,
  "messages"
> & { failures?: number } {
  const calls = { count: 0 };
  return {
    messages: async () => {
      calls.count += 1;
      if (calls.count < 0) throw new Error("unreachable");
      return [...messages];
    },
  };
}

/** 失败注入 store：add 永远抛错，用于验收场景 3。 */
function failingStore(): DistillCandidateStore & { added: DistillCandidate[][] } {
  const added: DistillCandidate[][] = [];
  return {
    added,
    list: async () => [],
    add: async (candidates) => {
      added.push([...candidates]);
      throw new Error("disk full");
    },
    confirm: async () => undefined,
    delete: async () => false,
    promote: async () => undefined,
  };
}

function recorderLogger() {
  const entries: { level: "info" | "warn"; event: string }[] = [];
  return {
    entries,
    logger: {
      info: (_message: string, context: { event: string }) => {
        entries.push({ level: "info", event: context.event });
      },
      warn: (_message: string, context: { event: string }) => {
        entries.push({ level: "warn", event: context.event });
      },
    },
  };
}

// ── 映射（durable messages → DistillSessionInput） ────────────

test("真实用户输入与 assistant 可见文本按 part 顺序映射为片段", () => {
  const input = mapDurableMessagesToDistillInput({
    sessionId: SESSION_ID,
    messages: [
      userMessage("u1", ["请修一下 lint"]),
      assistantMessage("a1", [textPart("先用这个命令检查："), bashPart("pnpm lint"), textPart("修好了")]),
    ],
  });

  assert.equal(input.sessionId, SESSION_ID);
  assert.deepEqual(
    input.fragments.map((fragment) => `${fragment.role}:${fragment.text}`),
    [
      "user:请修一下 lint",
      "assistant:先用这个命令检查：",
      "assistant:`pnpm lint`",
      "assistant:修好了",
    ],
  );
});

test("Bash 命令注成行内反引号片段，重复出现可被提取器统计为高频命令", () => {
  const input = mapDurableMessagesToDistillInput({
    sessionId: SESSION_ID,
    messages: [
      assistantMessage("a1", [bashPart("pnpm lint")]),
      userMessage("u1", ["好的"]),
      assistantMessage("a2", [bashPart("pnpm lint")]),
    ],
  });

  const commandFragments = input.fragments.filter((fragment) => fragment.text.startsWith("`"));
  assert.equal(commandFragments.length, 2);
  assert.deepEqual(
    commandFragments.map((fragment) => fragment.text),
    ["`pnpm lint`", "`pnpm lint`"],
  );
});

test("model-only 输入、compact 摘要、ignored 文本与非 Bash 工具不进提取输入", () => {
  const modelOnly = userMessage("u-goal", ["继续推进目标"], { source: "goal-continuation" });
  const summaryUser = userMessage("u-summary", ["历史摘要"], {
    summary: { added: 0 } as never,
  });
  const summaryAssistant = assistantMessage("a-summary", [textPart("摘要")]);
  summaryAssistant.info.summary = true;
  const noisyAssistant = assistantMessage("a1", [
    textPart("可见正文"),
    textPart("被忽略的草稿", { ignored: true }),
  ]);

  const input = mapDurableMessagesToDistillInput({
    sessionId: SESSION_ID,
    messages: [modelOnly, summaryUser, summaryAssistant, noisyAssistant],
  });

  assert.deepEqual(
    input.fragments.map((fragment) => `${fragment.role}:${fragment.text}`),
    ["assistant:可见正文"],
  );
});

test("同 id part 只计一次（防重复计数命令出现次数）", () => {
  const first = bashPart("pnpm test");
  const updated = { ...first, state: { ...first.state, output: "done" } };
  const input = mapDurableMessagesToDistillInput({
    sessionId: SESSION_ID,
    messages: [assistantMessage("a1", [first, updated])],
  });

  assert.equal(input.fragments.length, 1);
  assert.equal(input.fragments[0].text, "`pnpm test`");
});

test("Bash input.command 缺失或为空串不算命令信号", () => {
  const empty = { ...bashPart("x") };
  empty.state = { ...empty.state, input: {} };
  const blank = { ...bashPart("x") };
  blank.state = { ...blank.state, input: { command: "   " } };
  const input = mapDurableMessagesToDistillInput({
    sessionId: SESSION_ID,
    messages: [assistantMessage("a1", [empty, blank])],
  });

  assert.deepEqual(input.fragments, []);
});

// ── 触发器（验收场景 1 落盘 / 场景 3 失败不影响关闭 / 频控） ──

test("触发器把候选带来源工作区写入真实 store（tmpdir 落盘）", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-distill-trigger-"));
  try {
    const store = createDistillCandidateStore({ distillRootDir: path.join(root, "distill") });
    const { logger } = recorderLogger();
    // 同一命令出现两次（两次 Bash 调用）→ 满足重复命令阈值。
    await runSessionCloseDistillTrigger({
      sessionId: SESSION_ID,
      sessionStore: fakeSessionStore([
        assistantMessage("a1", [bashPart("pnpm verify:pre-push")]),
        userMessage("u1", ["跑一下"]),
        assistantMessage("a2", [bashPart("pnpm verify:pre-push")]),
      ]),
      workingDirectory: WORKING_DIRECTORY,
      workspaceIdentity: "  ",
      logger,
      store,
    });

    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].kind, "repeated-command");
    // 身份按 AGENTS.md 规则 trim 后为空 → 只落 path，不伪造 identity。
    assert.deepEqual(listed[0].workspace, { path: WORKING_DIRECTORY });

    const raw = JSON.parse(
      await readFile(path.join(root, "distill", "candidates.json"), "utf8"),
    );
    assert.equal(raw.candidates[0].workspace.path, WORKING_DIRECTORY);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspaceIdentity 非空时随候选落盘", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-distill-trigger-"));
  try {
    const store = createDistillCandidateStore({ distillRootDir: path.join(root, "distill") });
    const { logger } = recorderLogger();
    await runSessionCloseDistillTrigger({
      sessionId: "sess-distill-identity" as SessionId,
      sessionStore: fakeSessionStore([
        assistantMessage("a1", [bashPart("pnpm lint"), bashPart("pnpm lint")]),
      ]),
      workingDirectory: WORKING_DIRECTORY,
      workspaceIdentity: "team-workspace",
      logger,
      store,
    });

    const listed = await store.list();
    assert.deepEqual(listed[0].workspace, { identity: "team-workspace", path: WORKING_DIRECTORY });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store.add 失败只记 warn，不向关闭链路抛错（验收场景 3）", async () => {
  const failing = failingStore();
  const { entries, logger } = recorderLogger();
  await assert.doesNotReject(
    runSessionCloseDistillTrigger({
      sessionId: "sess-distill-fail" as SessionId,
      sessionStore: fakeSessionStore([
        assistantMessage("a1", [bashPart("pnpm lint"), bashPart("pnpm lint")]),
      ]),
      workingDirectory: WORKING_DIRECTORY,
      logger,
      store: failing,
    }),
  );
  assert.equal(failing.added.length, 1);
  assert.ok(entries.some((entry) => entry.level === "warn" && entry.event === "auto_distill.trigger.failed"));
});

test("messages 读取失败同样只记 warn（验收场景 3）", async () => {
  const { entries, logger } = recorderLogger();
  const brokenStore = {
    messages: async () => {
      throw new Error("store closed");
    },
  };
  await assert.doesNotReject(
    runSessionCloseDistillTrigger({
      sessionId: "sess-distill-read-fail" as SessionId,
      sessionStore: brokenStore,
      workingDirectory: WORKING_DIRECTORY,
      logger,
    }),
  );
  assert.ok(entries.some((entry) => entry.level === "warn"));
});

test("同会话第二次触发被频控挡住，不重复 add", async () => {
  const addedBatches: DistillCandidate[][] = [];
  const countingStore: DistillCandidateStore = {
    list: async () => [],
    add: async (candidates) => {
      addedBatches.push([...candidates]);
    },
    confirm: async () => undefined,
    delete: async () => false,
    promote: async () => undefined,
  };
  const { logger } = recorderLogger();
  const messages = [
    assistantMessage("a1", [bashPart("pnpm lint"), bashPart("pnpm lint")]),
  ];
  for (let round = 0; round < 2; round += 1) {
    await runSessionCloseDistillTrigger({
      sessionId: "sess-distill-once" as SessionId,
      sessionStore: fakeSessionStore(messages),
      workingDirectory: WORKING_DIRECTORY,
      logger,
      store: countingStore,
    });
  }

  assert.equal(addedBatches.length, 1);
});

test("无可复用信号时触发器不写 store", async () => {
  const addedBatches: DistillCandidate[][] = [];
  const countingStore: DistillCandidateStore = {
    list: async () => [],
    add: async (candidates) => {
      addedBatches.push([...candidates]);
    },
    confirm: async () => undefined,
    delete: async () => false,
    promote: async () => undefined,
  };
  const { logger } = recorderLogger();
  await runSessionCloseDistillTrigger({
    sessionId: "sess-distill-empty" as SessionId,
    sessionStore: fakeSessionStore([userMessage("u1", ["你好"])]),
    workingDirectory: WORKING_DIRECTORY,
    logger,
    store: countingStore,
  });

  assert.equal(addedBatches.length, 0);
});
