// 外部会话只读互操作单测（specs/external-sessions.md 验收场景）：
// - 解析：正常行 / 未知 type 行 / 损坏行三类；messageCount 只计 user/assistant。
// - 元数据：summary 标题、首条用户消息截断回退、cwd 还原 projectPath、
//   时间戳缺失回退文件 mtime、按 lastUpdatedAt 降序。
// - 边界：~/.claude/projects 外路径拒绝（前缀 + 符号链接逃逸）、
//   sessionId 路径穿越拒绝、目录不存在返回空列表不报错。
// - 工具面：契约 strict、描述含隐私警示、未找到会话映射稳定错误码。
// fixture 全部为虚构脱敏数据（fake 用户名/项目/uuid），不含真实凭据。

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  EXTERNAL_SESSION_TITLE_MAX_CHARS,
  ListExternalSessionsInputSchema,
  ReadExternalSessionInputSchema,
} from "@zcode/contracts";
import {
  ExternalSessionNotFoundError,
  listExternalSessions,
  readExternalSession,
} from "../../src/external-sessions/index.js";
import { assertPathWithinRoot } from "../../src/external-sessions/paths.js";
import {
  LIST_EXTERNAL_SESSIONS_DESCRIPTION,
  READ_EXTERNAL_SESSION_DESCRIPTION,
} from "../../src/tool/handlers/external-session-descriptions.js";
import { listExternalSessionsToolEntry } from "../../src/tool/handlers/external-session-list.js";
import { readExternalSessionToolEntry } from "../../src/tool/handlers/external-session-read.js";
import type { ToolExecutionContext } from "../../src/tool/types.js";

// ── 脱敏合成 fixture ─────────────────────────────────────────

const DEMO_APP_DIR = "-Users-demo-work-demo-app";
const OTHER_APP_DIR = "-Users-demo-work-other-app";
const DEMO_APP_PATH = "/Users/demo/work/demo-app";
const OTHER_APP_PATH = "/Users/demo/work/other-app";

const TS_A0 = Date.parse("2026-01-02T10:00:00.000Z");
const TS_A1 = Date.parse("2026-01-02T10:00:05.000Z");
const TS_A2 = Date.parse("2026-01-02T10:00:06.000Z");
const TS_A3 = Date.parse("2026-01-02T10:05:00.000Z");
const TS_B0 = Date.parse("2026-01-02T11:00:00.000Z");
const TS_B1 = Date.parse("2026-01-02T11:00:10.000Z");
/** session-c 的 mtime 回退锚点（早于所有行时间戳，验证排序末位）。 */
const MTIME_C = Date.UTC(2025, 11, 31, 9, 0, 0);

/** session-a：summary + 正常行 + tool_result-only 行 + 未知 type 行 + 损坏行。 */
const SESSION_A_JSONL = [
  JSON.stringify({ type: "summary", summary: "Fix login bug", leafUuid: "u1" }),
  JSON.stringify({
    type: "user",
    message: { role: "user", content: "Please fix the login bug in auth.ts" },
    timestamp: "2026-01-02T10:00:00.000Z",
    cwd: DEMO_APP_PATH,
    sessionId: "sess-a",
    uuid: "u2",
    version: "1.0.0",
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect auth.ts first." },
        { type: "tool_use", id: "t1", name: "Read", input: { path: DEMO_APP_PATH + "/auth.ts" } },
      ],
    },
    timestamp: "2026-01-02T10:00:05.000Z",
    cwd: DEMO_APP_PATH,
    sessionId: "sess-a",
    uuid: "u3",
  }),
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "file content omitted" }],
    },
    timestamp: "2026-01-02T10:00:06.000Z",
    cwd: DEMO_APP_PATH,
    sessionId: "sess-a",
    uuid: "u4",
  }),
  JSON.stringify({ type: "system", subtype: "status", timestamp: "2026-01-02T10:00:07.000Z" }),
  "{this line is not valid json",
  JSON.stringify({
    type: "user",
    message: { role: "user", content: "Thanks, please add a regression test." },
    timestamp: "2026-01-02T10:05:00.000Z",
    cwd: DEMO_APP_PATH,
    sessionId: "sess-a",
    uuid: "u5",
  }),
].join("\n");

/** session-b：无 summary 行，超长首条用户消息验证标题截断回退。 */
const SESSION_B_FIRST_USER = "Refactor the payment module, split charge and refund flows "
  .repeat(3)
  .trim();
const SESSION_B_JSONL = [
  JSON.stringify({
    type: "user",
    message: { role: "user", content: SESSION_B_FIRST_USER },
    timestamp: "2026-01-02T11:00:00.000Z",
    cwd: OTHER_APP_PATH,
    sessionId: "sess-b",
    uuid: "u10",
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Starting with the charge flow." }],
    },
    timestamp: "2026-01-02T11:00:10.000Z",
    cwd: OTHER_APP_PATH,
    sessionId: "sess-b",
    uuid: "u11",
  }),
].join("\n");

/** session-c：无任何时间戳，lastUpdatedAt 回退文件 mtime。 */
const SESSION_C_JSONL = [
  JSON.stringify({
    type: "user",
    message: { role: "user", content: "hello" },
    cwd: DEMO_APP_PATH,
    sessionId: "sess-c",
    uuid: "u20",
  }),
].join("\n");

async function createFixtureHome(): Promise<string> {
  const homeDir = await mkdtemp(path.join(tmpdir(), "zcode-ext-sessions-"));
  const projectsRoot = path.join(homeDir, ".claude", "projects");
  const demoDir = path.join(projectsRoot, DEMO_APP_DIR);
  const otherDir = path.join(projectsRoot, OTHER_APP_DIR);
  await mkdir(demoDir, { recursive: true });
  await mkdir(otherDir, { recursive: true });
  await writeFile(path.join(demoDir, "sess-a.jsonl"), SESSION_A_JSONL, "utf8");
  await writeFile(path.join(otherDir, "sess-b.jsonl"), SESSION_B_JSONL, "utf8");
  const sessionC = path.join(demoDir, "sess-c.jsonl");
  await writeFile(sessionC, SESSION_C_JSONL, "utf8");
  const mtime = new Date(MTIME_C);
  await utimes(sessionC, mtime, mtime);
  return homeDir;
}

function toolContext(): ToolExecutionContext {
  return {
    toolCallId: "test-call",
    traceId: "test-trace" as ToolExecutionContext["traceId"],
    abortSignal: new AbortController().signal,
    workspaceRoot: "/workspaces/demo",
    workingDirectory: "/workspaces/demo",
  } as ToolExecutionContext;
}

// ── list：元数据与解析 ────────────────────────────────────────

test("list returns metadata: summary title, cwd projectPath, timestamps, messageCount", async () => {
  const homeDir = await createFixtureHome();
  try {
    const sessions = await listExternalSessions({}, { homeDir });
    const sessionA = sessions.find((session) => session.sessionId === "sess-a");
    assert.ok(sessionA, "sess-a should be listed");
    assert.equal(sessionA.title, "Fix login bug");
    assert.equal(sessionA.projectPath, DEMO_APP_PATH);
    assert.equal(sessionA.startedAt, TS_A0);
    assert.equal(sessionA.lastUpdatedAt, TS_A3);
    // messageCount 只计 user/assistant 行：4 条（含 tool_result-only 的 user 行）。
    assert.equal(sessionA.messageCount, 4);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("list sorts sessions by lastUpdatedAt descending and falls back to file mtime", async () => {
  const homeDir = await createFixtureHome();
  try {
    const sessions = await listExternalSessions({}, { homeDir });
    assert.deepEqual(
      sessions.map((session) => session.sessionId),
      ["sess-b", "sess-a", "sess-c"],
    );
    const sessionC = sessions.find((session) => session.sessionId === "sess-c");
    assert.ok(sessionC);
    // 无时间戳：startedAt 省略，lastUpdatedAt 回退 mtime（容许文件系统精度误差）。
    assert.equal(sessionC.startedAt, undefined);
    assert.ok(Math.abs(sessionC.lastUpdatedAt - MTIME_C) < 5);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("list title falls back to truncated first user message without a summary line", async () => {
  const homeDir = await createFixtureHome();
  try {
    const sessions = await listExternalSessions({}, { homeDir });
    const sessionB = sessions.find((session) => session.sessionId === "sess-b");
    assert.ok(sessionB);
    const expected = SESSION_B_FIRST_USER.slice(0, EXTERNAL_SESSION_TITLE_MAX_CHARS - 1) + "…";
    assert.equal(sessionB.title, expected);
    assert.ok(sessionB.title.length <= EXTERNAL_SESSION_TITLE_MAX_CHARS);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("list filters by projectPath and returns empty for an unknown project", async () => {
  const homeDir = await createFixtureHome();
  try {
    const demo = await listExternalSessions({ projectPath: DEMO_APP_PATH + "/" }, { homeDir });
    assert.deepEqual(demo.map((session) => session.sessionId).sort(), ["sess-a", "sess-c"]);
    const none = await listExternalSessions(
      { projectPath: "/Users/demo/work/missing" },
      { homeDir },
    );
    assert.deepEqual(none, []);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("list returns an empty array without error when ~/.claude/projects is absent", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "zcode-ext-sessions-empty-"));
  try {
    const sessions = await listExternalSessions({}, { homeDir });
    assert.deepEqual(sessions, []);
    await assert.rejects(readExternalSession({ sessionId: "sess-a" }, { homeDir }));
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

// ── read：内容提取与容错 ──────────────────────────────────────

test("read extracts text-only content from user/assistant lines", async () => {
  const homeDir = await createFixtureHome();
  try {
    const output = await readExternalSession({ sessionId: "sess-a" }, { homeDir });
    assert.equal(output.sessionId, "sess-a");
    assert.equal(output.title, "Fix login bug");
    assert.equal(output.projectPath, DEMO_APP_PATH);
    assert.equal(output.messageCount, 4);
    assert.deepEqual(
      output.messages.map((message) => message.role),
      ["user", "assistant", "user", "user"],
    );
    assert.equal(output.messages[0]?.content, "Please fix the login bug in auth.ts");
    // blocks 数组只取文本类 block：tool_use 的结构化内容不进入文本。
    assert.equal(output.messages[1]?.content, "I will inspect auth.ts first.");
    // tool_result-only 的 user 回合是合法行：保留占位（content 为空串）。
    assert.equal(output.messages[2]?.content, "");
    assert.equal(output.messages[3]?.timestamp, TS_A3);
    // 未知 type 行（system）与损坏行跳过并计数，不中断读取。
    assert.deepEqual(output.warnings, ["Skipped 2 lines (1 unknown type, 1 malformed)"]);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("read omits warnings when every line parses cleanly", async () => {
  const homeDir = await createFixtureHome();
  try {
    const output = await readExternalSession({ sessionId: "sess-b" }, { homeDir });
    assert.equal(output.warnings, undefined);
    assert.equal(output.messages[0]?.timestamp, TS_B0);
    assert.equal(output.messages[1]?.timestamp, TS_B1);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("read rejects an unknown session id with a readable error", async () => {
  const homeDir = await createFixtureHome();
  try {
    await assert.rejects(
      readExternalSession({ sessionId: "no-such-session" }, { homeDir }),
      (error: unknown) => {
        assert.ok(error instanceof ExternalSessionNotFoundError);
        assert.match(error.message, /not found/i);
        return true;
      },
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

// ── 路径边界 ─────────────────────────────────────────────────

test("boundary guard rejects paths outside ~/.claude/projects and symlink escapes", async () => {
  const homeDir = await createFixtureHome();
  try {
    const root = path.join(homeDir, ".claude", "projects");
    // 根自身与根内路径放行。
    await assertPathWithinRoot(root, root);
    await assertPathWithinRoot(root, path.join(root, DEMO_APP_DIR, "sess-a.jsonl"));
    // 前缀越界：根外的兄弟路径拒绝，报错信息可读。
    await assert.rejects(
      assertPathWithinRoot(root, path.join(homeDir, ".claude", "settings.json")),
      /outside .*boundary/,
    );
    await assert.rejects(
      assertPathWithinRoot(root, path.join(root, "..", "..", "secret.txt")),
      /outside .*boundary|symlink escape/,
    );
    // 符号链接逃逸：根内符号链接指向根外文件，realpath 防线拒绝。
    const outsideFile = path.join(homeDir, "outside-secret.txt");
    await writeFile(outsideFile, "sanitized", "utf8");
    const linkPath = path.join(root, DEMO_APP_DIR, "linked.jsonl");
    await symlink(outsideFile, linkPath);
    await assert.rejects(assertPathWithinRoot(root, linkPath), /symlink escape/);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("read rejects session ids that try to traverse out of the boundary", async () => {
  const homeDir = await createFixtureHome();
  try {
    for (const sessionId of ["../secret", "..\\secret", ".", "..", "a/b"]) {
      await assert.rejects(
        readExternalSession({ sessionId }, { homeDir }),
        /Invalid external session id/,
      );
    }
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

// ── 工具面（thin glue）──────────────────────────────────────

test("tool entries are read-only with no side effects and carry the privacy notice", () => {
  for (const entry of [listExternalSessionsToolEntry, readExternalSessionToolEntry]) {
    assert.equal(entry.metadata.readOnly, true);
    assert.equal(entry.metadata.destructive, false);
    assert.equal(entry.metadata.sideEffectScope, "none");
    assert.equal(entry.permission.sideEffectScope, "none");
    assert.equal(entry.permission.needsApproval, false);
  }
  for (const description of [
    LIST_EXTERNAL_SESSIONS_DESCRIPTION,
    READ_EXTERNAL_SESSION_DESCRIPTION,
  ]) {
    assert.match(description, /read-only/);
    assert.match(description, /sensitive paths, arguments and credentials/);
  }
});

test("input schemas are strict and required fields are enforced", () => {
  assert.equal(ListExternalSessionsInputSchema.safeParse({ unexpected: 1 }).success, false);
  assert.equal(ListExternalSessionsInputSchema.safeParse({}).success, true);
  assert.equal(ReadExternalSessionInputSchema.safeParse({}).success, false);
  assert.equal(ReadExternalSessionInputSchema.safeParse({ sessionId: "s" }).success, true);
});

test("read handler maps not-found to a recoverable core error with a stable code", async () => {
  await assert.rejects(
    readExternalSessionToolEntry.handler(
      { sessionId: "zcode-test-missing-session" },
      toolContext(),
    ),
    (error: unknown) => {
      const context = (error as { context?: { code?: string } }).context;
      assert.equal(context?.code, "external_session_not_found");
      return true;
    },
  );
});

test("formatModelContent renders an empty list and a transcript preview", () => {
  const empty = listExternalSessionsToolEntry.formatModelContent?.({ sessions: [] });
  assert.match(String(empty), /No Claude Code sessions found/);
  const transcript = readExternalSessionToolEntry.formatModelContent?.({
    sessionId: "sess-x",
    projectPath: "/Users/demo/work/demo-app",
    messages: [
      { role: "user", content: "hi", timestamp: TS_A0 },
      { role: "assistant", content: "", timestamp: TS_A1 },
    ],
    messageCount: 2,
    warnings: ["Skipped 1 lines (1 malformed)"],
  });
  assert.match(String(transcript), /user: hi/);
  assert.match(String(transcript), /assistant: \(no text\)/);
  assert.match(String(transcript), /Skipped 1 lines/);
});
