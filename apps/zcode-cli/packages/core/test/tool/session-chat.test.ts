// 会话互聊（实验）工具面单测：三工具 handler 行为 + 契约边界。
// - SessionList：excludeSessionId 透传、contacts 原样返回。
// - SessionTalk：自呼拒绝（invalid_target）、delivered/queued/rejected 三态映射、
//   超长消息被契约 schema 拒绝（8_000 字符上限）。
// - SessionCreate：title/firstMessage 透传、sessionId 返回。
// - 端口缺席：注册门之外走到 handler 属接线故障，抛 ConfigurationError（照 escalate）。

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SESSION_TALK_MESSAGE_MAX_CHARS,
  SessionTalkInputSchema,
  type SessionChatPort,
} from "@zcode/contracts";
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
        { sessionId: "sess_other", title: "修 bug", status: "running", updatedAt: 2 },
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
      { sessionId: "sess_other", title: "修 bug", status: "running", updatedAt: 2 },
      { sessionId: "sess_idle", title: "", status: "idle", updatedAt: 1 },
    ],
  });
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
