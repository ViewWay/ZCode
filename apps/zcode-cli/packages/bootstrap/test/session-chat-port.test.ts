// 会话互聊（实验）协议端口单测：联系人过滤、投递三态、来源标注与协作者创建。
// 全部走最小 fake context（sessions 注册表 + sessionStore 标题解析），不启动协议 server。

import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionChatPort } from "@zcode/contracts";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";
import {
  buildSessionChatMessage,
  createProtocolSessionChatPort,
} from "../src/zcode-protocol/session-chat-port.js";

interface FakeRecordParts {
  sessionId: string;
  taskType?: string;
  persistence?: "immediate" | "deferred";
  updatedAt?: number;
  running?: boolean;
  sendInput?: (input: unknown, options?: unknown) => Promise<unknown>;
}

function fakeRecord(parts: FakeRecordParts): ZCodeProtocolSessionRecord {
  const sentInputs: Array<{ input: unknown; options?: unknown }> = [];
  return {
    app: {
      sessionId: parts.sessionId,
      sendInput:
        parts.sendInput ??
        (async (input: unknown, options?: unknown) => {
          sentInputs.push({ input, options });
          return { kind: "started_turn", turnId: "t1" };
        }),
      setCustomSessionTitle: async () => {},
    },
    memoryEnabled: false,
    nativeSearchEnhancementsEnabled: false,
    modelContextBudgetStrategy: "balanced",
    createdAt: 1,
    eventStore: {} as never,
    persistence: parts.persistence ?? "immediate",
    protocolEventSequences: new Map(),
    protocolToolInputTransmissions: new Map(),
    stateRevision: 0,
    taskType: (parts.taskType ?? "interactive") as never,
    traceContext: {} as never,
    updatedAt: parts.updatedAt ?? 1,
    workspace: { workspaceKey: "ws-demo", workspacePath: "/workspaces/demo" },
    ...(parts.running ? { activeAbortController: new AbortController() } : {}),
    ...(parts.sendInput ? {} : { __sentInputs: sentInputs }),
  } as unknown as ZCodeProtocolSessionRecord & { __sentInputs?: unknown[] };
}

function fakeContext(sessions: ZCodeProtocolSessionRecord[]): ZCodeProtocolAgentServerContext {
  const map = new Map<string, ZCodeProtocolSessionRecord>();
  for (const record of sessions) map.set(String(record.app.sessionId), record);
  return {
    sessions: map,
    deps: {
      sessionStore: {
        getSession: async (id: string) =>
          id === "sess_self" ? { title: "Source Session" } : { title: `Title-${id}` },
      },
    },
    logger: { warn() {}, info() {} },
  } as unknown as ZCodeProtocolAgentServerContext;
}

function port(
  context: ZCodeProtocolAgentServerContext,
  ownSessionId?: string,
  createRecord?: (rawParams: unknown) => Promise<{ sessionId: string }>,
): SessionChatPort {
  return createProtocolSessionChatPort(
    context,
    ownSessionId ? () => context.sessions.get(ownSessionId) : () => undefined,
    {
      createRecord:
        createRecord ?? (async () => ({ sessionId: "sess_unreachable" })),
    },
  );
}

test("buildSessionChatMessage carries the inter-chat origin header and reply guidance", () => {
  const text = buildSessionChatMessage({
    fromSessionId: "sess_self",
    fromTitle: "Source Session",
    message: "Which middleware did you pick?",
  });
  assert.ok(text.includes("[Session Inter-Chat / 会话互聊]"));
  assert.ok(text.includes("not from the user"));
  assert.ok(text.includes('targetSessionId "sess_self"'));
  assert.ok(text.endsWith("Which middleware did you pick?"));
});

test("listSessions keeps sidebar-visible live sessions, excludes own/deferred/subagent, sorts by recency", async () => {
  const context = fakeContext([
    fakeRecord({ sessionId: "sess_self", updatedAt: 9 }),
    fakeRecord({ sessionId: "sess_old", updatedAt: 1 }),
    fakeRecord({ sessionId: "sess_running", updatedAt: 5, running: true }),
    fakeRecord({ sessionId: "sess_draft", persistence: "deferred", updatedAt: 8 }),
    fakeRecord({ sessionId: "sess_child", taskType: "subagent_child", updatedAt: 7 }),
  ]);
  const contacts = await port(context, "sess_self").listSessions({
    excludeSessionId: "sess_self",
  });
  assert.deepEqual(
    contacts.map((contact) => contact.sessionId),
    ["sess_running", "sess_old"],
  );
  assert.equal(contacts[0]?.status, "running");
  assert.equal(contacts[0]?.title, "Title-sess_running");
  assert.equal(contacts[1]?.status, "idle");
});

test("talkToSession: unknown/self/hidden targets reject with stable reasons", async () => {
  const context = fakeContext([
    fakeRecord({ sessionId: "sess_self" }),
    fakeRecord({ sessionId: "sess_child", taskType: "subagent_child" }),
  ]);
  const chat = port(context, "sess_self");
  assert.deepEqual(await chat.talkToSession({ targetSessionId: "sess_ghost", fromSessionId: "sess_self", message: "m" }), {
    kind: "rejected",
    reason: "session_not_found",
  });
  assert.deepEqual(await chat.talkToSession({ targetSessionId: "sess_self", fromSessionId: "sess_self", message: "m" }), {
    kind: "rejected",
    reason: "invalid_target",
  });
  assert.deepEqual(await chat.talkToSession({ targetSessionId: "sess_child", fromSessionId: "sess_self", message: "m" }), {
    kind: "rejected",
    reason: "invalid_target",
  });
});

test("talkToSession: injects the annotated message via sendInput; queues map to queued", async () => {
  const sent: Array<{ input: unknown; options?: unknown }> = [];
  const target = fakeRecord({
    sessionId: "sess_other",
    sendInput: async (input: unknown, options?: unknown) => {
      sent.push({ input, options });
      return { kind: "started_turn", turnId: "t1" };
    },
  });
  const context = fakeContext([fakeRecord({ sessionId: "sess_self" }), target]);
  const chat = port(context, "sess_self");
  const delivered = await chat.talkToSession({
    targetSessionId: "sess_other",
    fromSessionId: "sess_self",
    message: "status check",
  });
  assert.deepEqual(delivered, { kind: "delivered", targetSessionId: "sess_other", queued: false });
  const text = (sent[0]?.input as { text: string }).text;
  assert.ok(text.includes("[Session Inter-Chat / 会话互聊]"));
  assert.ok(text.includes('"Source Session"'));
  assert.ok(text.includes("status check"));
  const inputId = (sent[0]?.options as { inputId: string }).inputId;
  assert.ok(inputId.startsWith("session-chat:"), `inputId prefix: ${inputId}`);

  const busy = fakeRecord({
    sessionId: "sess_busy",
    sendInput: async () => ({ kind: "queued", pendingInputId: "p1" }),
  });
  const busyContext = fakeContext([fakeRecord({ sessionId: "sess_self" }), busy]);
  const queued = await port(busyContext, "sess_self").talkToSession({
    targetSessionId: "sess_busy",
    fromSessionId: "sess_self",
    message: "later",
  });
  assert.deepEqual(queued, { kind: "delivered", targetSessionId: "sess_busy", queued: true });
});

test("createCollaboratorSession: reuses injected record factory, sets title, delivers annotated first message", async () => {
  const createdParams: unknown[] = [];
  const context = fakeContext([fakeRecord({ sessionId: "sess_self" })]);
  const sent: Array<{ input: unknown; options?: unknown }> = [];
  const chat = port(
    context,
    "sess_self",
    async (rawParams) => {
      createdParams.push(rawParams);
      const record = fakeRecord({
        sessionId: "sess_new",
        sendInput: async (input: unknown, options?: unknown) => {
          sent.push({ input, options });
          return { kind: "started_turn", turnId: "t2" };
        },
      });
      context.sessions.set("sess_new", record);
      return { sessionId: "sess_new" };
    },
  );
  const result = await chat.createCollaboratorSession({
    fromSessionId: "sess_self",
    title: "coverage audit",
    firstMessage: "Run the tests",
  });
  assert.equal(result.sessionId, "sess_new");
  const params = createdParams[0] as {
    workspace: { workspaceKey: string };
    persistence: string;
    parentSessionId: string;
  };
  assert.equal(params.workspace.workspaceKey, "ws-demo");
  assert.equal(params.persistence, "immediate");
  assert.equal(params.parentSessionId, "sess_self");
  const text = (sent[0]?.input as { text: string }).text;
  assert.ok(text.includes("[Session Inter-Chat / 会话互聊]"));
  assert.ok(text.includes("Run the tests"));
});

test("createCollaboratorSession: missing own record fails fast", async () => {
  const context = fakeContext([]);
  await assert.rejects(
    port(context, "sess_self").createCollaboratorSession({ fromSessionId: "sess_self", title: "t" }),
  );
});
