// 会话互聊工具面单测（specs/session-chat.md）：三工具 handler 行为 + 契约边界。
// - SessionList：excludeSessionId 透传、busy/idle 透传、端口未提供 status 的旧
//   实现按 idle 兼容、title 可选省略。
// - SessionTalk：自呼拒绝（invalid_target）、delivered/queued/rejected 三态映射、
//   连续投递保持调用顺序（fire-and-return 串行）、超长消息被契约 schema 拒绝。
// - SessionCreate：title/firstMessage 透传、sessionId 返回。
// - 端口缺席：注册门（includeSessionChat）不开即不注册；注册门之外走到 handler
//   属接线故障，抛 ConfigurationError（照 escalate）。

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SESSION_CREATE_TOOL_NAME,
  SESSION_LIST_TOOL_NAME,
  SESSION_TALK_MESSAGE_MAX_CHARS,
  SESSION_TALK_TOOL_NAME,
  SessionTalkInputSchema,
  type SessionChatPort,
} from "@zcode/contracts";
import { registerBuiltInTools } from "../../src/tool/handlers/index.js";
import {
  sessionCreateToolEntry,
  sessionListToolEntry,
  sessionTalkToolEntry,
} from "../../src/tool/handlers/session-chat.js";
import type { ToolExecutionContext } from "../../src/tool/types.js";

function chatContext(port?: SessionChatPort): ToolExecutionContext {
  return {
    toolCallId: "test-call",
    traceId: "test-trace" as ToolExecutionContext["traceId"],
    abortSignal: new AbortController().signal,
    workspaceRoot: "/workspaces/demo",
    workingDirectory: "/workspaces/demo",
    sessionId: "sess_self" as ToolExecutionContext["sessionId"],
    ...(port ? { sessionChatPort: port } : {}),
  } as ToolExecutionContext;
}

test("SessionList passes excludeSessionId and returns contacts", async () => {
  let seenExclude: string | undefined = "unset";
  const port: SessionChatPort = {
    async listSessions(input) {
      seenExclude = input.excludeSessionId;
      return [
        { sessionId: "sess_other", title: "修 bug", status: "busy", updatedAt: 2 },
        { sessionId: "sess_idle", title: "", status: "idle", updatedAt: 1 },
      ];
    },
    async talkToSession() {
      throw new Error("unused");
    },
    async createCollaboratorSession() {
      throw new Error("unused");
    },
  };
  const output = await sessionListToolEntry.handler({}, chatContext(port));
  assert.equal(seenExclude, "sess_self");
  assert.deepEqual(output, {
    sessions: [
      { sessionId: "sess_other", title: "修 bug", status: "busy", updatedAt: 2 },
      { sessionId: "sess_idle", title: "", status: "idle", updatedAt: 1 },
    ],
  });
});

test("SessionList derives busy/idle from the port only; legacy contacts fall back to idle", async () => {
  const port: SessionChatPort = {
    async listSessions() {
      return [
        // 端口实时提供 busy（唯一来源，core 不推导）。
        { sessionId: "sess_busy", title: "auth refactor", status: "busy", updatedAt: 4 },
        { sessionId: "sess_idle", title: "notes", status: "idle", updatedAt: 3 },
        // 旧端口实现：不提供 status → 按 idle 兼容。
        { sessionId: "sess_legacy", title: "legacy port", updatedAt: 2 },
        // title 可选：宿主解析不到标题时省略，不占位空串。
        { sessionId: "sess_untitled", status: "busy", updatedAt: 1 },
      ];
    },
    async talkToSession() {
      throw new Error("unused");
    },
    async createCollaboratorSession() {
      throw new Error("unused");
    },
  };
  const output = (await sessionListToolEntry.handler({}, chatContext(port))) as {
    sessions: Array<{ sessionId: string; title?: string; status: string }>;
  };
  assert.deepEqual(
    output.sessions.map((session) => session.status),
    ["busy", "idle", "idle", "busy"],
  );
  assert.equal("title" in output.sessions[3], false);
  const modelText = String(sessionListToolEntry.formatModelContent?.(output));
  assert.ok(modelText.includes("[busy] auth refactor"));
  assert.ok(modelText.includes("[idle] legacy port"));
  assert.ok(modelText.includes("[busy] (untitled)"));
});

test("SessionTalk rejects calling itself with stable invalid_target reason", async () => {
  let calls = 0;
  const port: SessionChatPort = {
    async listSessions() {
      return [];
    },
    async talkToSession() {
      calls += 1;
      return { kind: "delivered", targetSessionId: "x", queued: false };
    },
    async createCollaboratorSession() {
      throw new Error("unused");
    },
  };
  const output = (await sessionTalkToolEntry.handler(
    { targetSessionId: "sess_self", message: "hello" },
    chatContext(port),
  )) as { status: string; reason?: string };
  assert.equal(calls, 0);
  assert.equal(output.status, "rejected");
  assert.equal(output.reason, "invalid_target");
});

test("SessionTalk maps delivered / queued / rejected outcomes", async () => {
  const outcomes = [
    { kind: "delivered", targetSessionId: "sess_other", queued: false },
    { kind: "delivered", targetSessionId: "sess_other", queued: true },
    { kind: "rejected", reason: "session_not_found" as const },
  ];
  let index = 0;
  const port: SessionChatPort = {
    async listSessions() {
      return [];
    },
    async talkToSession() {
      return outcomes[index++] as never;
    },
    async createCollaboratorSession() {
      throw new Error("unused");
    },
  };
  const context = chatContext(port);
  const delivered = (await sessionTalkToolEntry.handler(
    { targetSessionId: "sess_other", message: "m1" },
    context,
  )) as { status: string; queued?: boolean };
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.queued, false);
  const queued = (await sessionTalkToolEntry.handler(
    { targetSessionId: "sess_other", message: "m2" },
    context,
  )) as { status: string; queued?: boolean };
  assert.equal(queued.status, "queued");
  assert.equal(queued.queued, true);
  const rejected = (await sessionTalkToolEntry.handler(
    { targetSessionId: "sess_missing", message: "m3" },
    context,
  )) as { status: string; reason?: string };
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reason, "session_not_found");
});

test("SessionTalk contract caps message length at 8_000 chars", () => {
  const ok = SessionTalkInputSchema.safeParse({
    targetSessionId: "sess_other",
    message: "x".repeat(SESSION_TALK_MESSAGE_MAX_CHARS),
  });
  assert.equal(ok.success, true);
  const tooLong = SessionTalkInputSchema.safeParse({
    targetSessionId: "sess_other",
    message: "x".repeat(SESSION_TALK_MESSAGE_MAX_CHARS + 1),
  });
  assert.equal(tooLong.success, false);
});

test("SessionCreate passes title/firstMessage and returns the new sessionId", async () => {
  const seen: unknown[] = [];
  const port: SessionChatPort = {
    async listSessions() {
      return [];
    },
    async talkToSession() {
      throw new Error("unused");
    },
    async createCollaboratorSession(input) {
      seen.push(input);
      return { sessionId: "sess_new" };
    },
  };
  const output = (await sessionCreateToolEntry.handler(
    { title: "coverage audit", firstMessage: "Run pnpm test" },
    chatContext(port),
  )) as { status: string; sessionId?: string };
  assert.equal(output.status, "created");
  assert.equal(output.sessionId, "sess_new");
  assert.deepEqual(seen, [
    {
      fromSessionId: "sess_self",
      title: "coverage audit",
      firstMessage: "Run pnpm test",
    },
  ]);
  // 无 firstMessage 时不传该键（端口契约：undefined 不占位）。
  const minimal = (await sessionCreateToolEntry.handler(
    { title: "solo" },
    chatContext(port),
  )) as { status: string };
  assert.equal(minimal.status, "created");
  assert.deepEqual(seen[1], { fromSessionId: "sess_self", title: "solo" });
});

test("port absence fails fast as a wiring fault for all three tools", async () => {
  const context = chatContext(undefined);
  await assert.rejects(sessionListToolEntry.handler({}, context));
  await assert.rejects(
    sessionTalkToolEntry.handler({ targetSessionId: "sess_other", message: "m" }, context),
  );
  await assert.rejects(sessionCreateToolEntry.handler({ title: "t" }, context));
});

test("SessionTalk keeps fire-and-return delivery order across sequential calls", async () => {
  const deliveries: Array<{ targetSessionId: string; fromSessionId: string; message: string }> = [];
  const port: SessionChatPort = {
    async listSessions() {
      return [];
    },
    async talkToSession(input) {
      deliveries.push(input);
      return { kind: "delivered", targetSessionId: input.targetSessionId, queued: false };
    },
    async createCollaboratorSession() {
      throw new Error("unused");
    },
  };
  const context = chatContext(port);
  // fire-and-return：admission 完成即返回，两次调用按顺序到达端口。
  await sessionTalkToolEntry.handler({ targetSessionId: "sess_a", message: "first" }, context);
  await sessionTalkToolEntry.handler({ targetSessionId: "sess_b", message: "second" }, context);
  assert.deepEqual(
    deliveries.map((delivery) => [delivery.targetSessionId, delivery.message]),
    [
      ["sess_a", "first"],
      ["sess_b", "second"],
    ],
  );
  assert.ok(deliveries.every((delivery) => delivery.fromSessionId === "sess_self"));
});

test("session chat tools stay unregistered without the port gate (fail-closed registration)", () => {
  const SESSION_CHAT_TOOL_NAMES = [
    SESSION_LIST_TOOL_NAME,
    SESSION_TALK_TOOL_NAME,
    SESSION_CREATE_TOOL_NAME,
  ] as const;
  function registeredNames(includeSessionChat?: boolean): string[] {
    const names: string[] = [];
    registerBuiltInTools(
      { register: (entry) => names.push(entry.metadata.name) },
      includeSessionChat === undefined ? {} : { includeSessionChat },
    );
    return names;
  }
  // 端口缺席（includeSessionChat 未开）：三工具不注册——不存在无端口的降级路径。
  const closed = registeredNames();
  for (const name of SESSION_CHAT_TOOL_NAMES) {
    assert.equal(closed.includes(name), false, `${name} must not register without the port`);
  }
  // 端口注入后（runtime-tools 由 sessionChatPort 推导 includeSessionChat=true）：注册。
  const open = registeredNames(true);
  for (const name of SESSION_CHAT_TOOL_NAMES) {
    assert.equal(open.includes(name), true, `${name} must register with the gate open`);
  }
});
