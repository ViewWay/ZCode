// A5 回放浏览器会话单测（specs/record-replay.md）：preflight 语义、dispatch 上下文
// （sessionId 前缀 + workspace 透传）、释放（list 后逐 tab close）与尽力而为清理。
import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserCommand, BrowserCommandResult, BrowserTabSummary } from "@zcode/shared";
import {
  acquireAutomationReplayBrowserSession,
  AUTOMATION_REPLAY_SESSION_PREFIX,
  buildAutomationReplaySessionId,
  type AutomationReplayBrowserSessionPort,
} from "../../src/host/automationReplayBrowserSession.js";

interface RecordedExecute {
  sessionId: string;
  workspaceKey?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  command: BrowserCommand;
}

function okResult(partial: Partial<BrowserCommandResult> = {}): BrowserCommandResult {
  return { ok: true, elapsedMs: 1, ...partial };
}

function errorResult(code = "backend_unavailable", message = "parentPort unavailable") {
  return { ok: false as const, elapsedMs: 1, error: { code, message } };
}

function makeTab(tabId: string): BrowserTabSummary {
  return { tabId, url: "https://example.test/", title: "t", viewport: { width: 800, height: 600 } };
}

/** 可编排 fake port：记录全部 execute 入参；list/close 结果可按需编排。 */
function createFakePort(options?: {
  preflight?: BrowserCommandResult;
  listTabs?: BrowserTabSummary[];
  closeResults?: Record<string, BrowserCommandResult>;
  throwOn?: string;
}): {
  port: AutomationReplayBrowserSessionPort;
  calls: RecordedExecute[];
} {
  const calls: RecordedExecute[] = [];
  const port: AutomationReplayBrowserSessionPort = {
    async execute(input) {
      calls.push({ ...input });
      if (options?.throwOn === input.command.method) {
        throw new Error("port exploded");
      }
      if (input.command.method === "list") {
        // list 被复用为 preflight 与释放枚举：默认空 tab 列表即可。
        if (
          options?.preflight &&
          calls.filter((call) => call.command.method === "list").length === 1
        ) {
          return options.preflight;
        }
        return okResult({ tabs: options?.listTabs ?? [] });
      }
      if (input.command.method === "close") {
        return options?.closeResults?.[input.command.tabId ?? ""] ?? okResult();
      }
      return okResult();
    },
  };
  return { port, calls };
}

test("preflight 通过：sessionId 带 automation-replay 前缀，workspace 字段透传", async () => {
  const { port, calls } = createFakePort({ listTabs: [makeTab("t1"), makeTab("t2")] });
  const session = await acquireAutomationReplayBrowserSession(
    {
      port,
      workspace: {
        workspaceKey: "/ws/key",
        workspacePath: "/ws/path",
        workspaceIdentity: "identity-1",
      },
    },
    "run-42",
  );
  assert.equal(
    buildAutomationReplaySessionId("run-42"),
    `${AUTOMATION_REPLAY_SESSION_PREFIX}run-42`,
  );
  // 第一次派发就是 preflight list，携带完整会话上下文。
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    sessionId: "automation-replay:run-42",
    workspaceKey: "/ws/key",
    workspacePath: "/ws/path",
    workspaceIdentity: "identity-1",
    command: { method: "list" },
  });
  assert.equal(session.executor.surface, "browser-command-bridge:automation-replay:session");
});

test("executor.executeStep 派发映射后的 BrowserCommand，携带同一会话上下文", async () => {
  const { port, calls } = createFakePort();
  const session = await acquireAutomationReplayBrowserSession({ port }, "run-1");
  const outcome = await session.executor.executeStep({
    seq: 1,
    action: "navigate",
    value: "https://example.test/",
  });
  assert.deepEqual(outcome, { ok: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].command, { method: "navigate", url: "https://example.test/" });
  assert.equal(calls[1].sessionId, "automation-replay:run-1");
});

test("preflight 失败（结构化 not-ok）：获取会话即失败，供调用方回退 unavailable", async () => {
  const { port } = createFakePort({ preflight: errorResult() });
  await assert.rejects(
    () => acquireAutomationReplayBrowserSession({ port }, "run-2"),
    /preflight failed: backend_unavailable/u,
  );
});

test("preflight 抛错：同样获取失败，不吞异常细节", async () => {
  const { port } = createFakePort({ throwOn: "list" });
  await assert.rejects(
    () => acquireAutomationReplayBrowserSession({ port }, "run-3"),
    /port exploded/u,
  );
});

test("release：list 出 scope 内 tabs 逐个 close，全部尽力而为不抛错", async () => {
  const { port, calls } = createFakePort({
    listTabs: [makeTab("t1"), makeTab("t2")],
    closeResults: { t2: errorResult("execution_error", "guest gone") },
  });
  const warnings: string[] = [];
  const session = await acquireAutomationReplayBrowserSession(
    { port, logger: { info: () => {}, warn: (message: string) => warnings.push(message) } },
    "run-4",
  );
  await session.release();
  const commands = calls.map((call) => call.command);
  assert.deepEqual(commands, [
    { method: "list" },
    { method: "list" },
    { method: "close", tabId: "t1" },
    { method: "close", tabId: "t2" },
  ]);
  // 单个 close 失败只告警，不影响整体释放。
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /close tab=t2 failed: execution_error/u);
});

test("release 自身异常（list 抛错）：不向上抛，只告警", async () => {
  const warnings: string[] = [];
  let listCallCount = 0;
  // 第一条 list（preflight）成功，之后的 list（release 枚举）抛错。
  const port: AutomationReplayBrowserSessionPort = {
    async execute(input) {
      if (input.command.method === "list") {
        listCallCount += 1;
        if (listCallCount > 1) throw new Error("port exploded");
        return okResult();
      }
      return okResult();
    },
  };
  const session = await acquireAutomationReplayBrowserSession(
    { port, logger: { info: () => {}, warn: (message: string) => warnings.push(message) } },
    "run-5",
  );
  await assert.doesNotReject(() => session.release());
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /release failed: port exploded/u);
});
