// A5 实时采集会话单测（specs/record-replay.md v1.1）：fake bridge 下的启动命令序列、
// 轮询 drain、URL 变化补 navigate、drain 失败容忍、停止/取消的释放语义
// （visibility 复位 + scope tabs close，尽力而为）。
import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserCommand, BrowserCommandResult, BrowserTabSummary } from "@zcode/shared";
import {
  AUTOMATION_CAPTURE_SESSION_PREFIX,
  startAutomationCaptureSession,
  type AutomationCaptureBrowserPort,
} from "../../src/host/automationCaptureSession.js";

interface RecordedCall {
  sessionId: string;
  workspaceKey?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  command: BrowserCommand;
}

function okResult(partial: Partial<BrowserCommandResult> = {}): BrowserCommandResult {
  return { ok: true, elapsedMs: 1, ...partial };
}

function errorResult(code: string, message: string): BrowserCommandResult {
  return { ok: false, elapsedMs: 1, error: { code, message } };
}

function makeTab(tabId: string, url: string): BrowserTabSummary {
  return { tabId, url, title: "t", viewport: { width: 800, height: 600 } };
}

/** fake bridge：记录全部调用；evaluate 消费队列，缺省返回当前 url 的空 drain。 */
function makeFakePort(options?: { listError?: boolean; newTabError?: boolean }) {
  const calls: RecordedCall[] = [];
  const state = {
    calls,
    url: "about:blank",
    evaluateQueue: [] as BrowserCommandResult[],
    tabs: [] as BrowserTabSummary[],
    closeFailures: 0,
    evaluateCount: 0,
  };
  const port: AutomationCaptureBrowserPort = {
    async execute(input) {
      calls.push({ ...input });
      const command = input.command;
      if (command.method === "list") {
        return options?.listError
          ? errorResult("backend_unavailable", "parentPort unavailable")
          : okResult({ tabs: state.tabs });
      }
      if (command.method === "newTab") {
        if (options?.newTabError) return errorResult("backend_unavailable", "no guest");
        const tab = makeTab("tab-1", "about:blank");
        state.tabs = [tab];
        return okResult({ tab });
      }
      if (command.method === "evaluate") {
        state.evaluateCount += 1;
        if (state.evaluateQueue.length > 0) {
          const queued = state.evaluateQueue.shift() as BrowserCommandResult;
          // 队列结果模拟一次页面状态：成功 drain 后 url 停留在该值，后续轮询继续返回它。
          if (
            queued.ok &&
            queued.value &&
            typeof queued.value === "object" &&
            "url" in queued.value
          ) {
            state.url = String((queued.value as { url: unknown }).url);
          }
          return queued;
        }
        return okResult({ value: { url: state.url, events: [] } });
      }
      if (command.method === "close") {
        if (state.closeFailures > 0) {
          state.closeFailures -= 1;
          return errorResult("execution_error", "close failed");
        }
        state.tabs = state.tabs.filter((tab) => tab.tabId !== command.tabId);
        return okResult();
      }
      return okResult();
    },
  };
  return { port, state };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function baseDeps(port: AutomationCaptureBrowserPort) {
  return {
    port,
    pollIntervalMs: 10,
    newCaptureId: () => "cap-test-1",
    workspace: { workspaceKey: "wk", workspacePath: "/w", workspaceIdentity: "wi" },
  };
}

test("preflight 失败整体拒绝，不再创建 tab", async () => {
  const { port, state } = makeFakePort({ listError: true });
  await assert.rejects(startAutomationCaptureSession(baseDeps(port)), /preflight failed/);
  assert.ok(state.calls.every((call) => call.command.method === "list"));
});

test("newTab 失败整体拒绝（诚实失败，不留半开会话）", async () => {
  const { port, state } = makeFakePort({ newTabError: true });
  await assert.rejects(startAutomationCaptureSession(baseDeps(port)), /failed to create tab/);
  assert.ok(state.calls.every((call) => call.command.method !== "activateTab"));
});

test("启动命令序列：list → newTab → activateTab → 可见性 → 首次 drain（安装）", async () => {
  const { port, state } = makeFakePort();
  const handle = await startAutomationCaptureSession(baseDeps(port));
  try {
    assert.equal(handle.sessionId, `${AUTOMATION_CAPTURE_SESSION_PREFIX}cap-test-1`);
    const methods = state.calls.map((call) => call.command.method);
    assert.deepEqual(methods.slice(0, 5), [
      "list",
      "newTab",
      "activateTab",
      "browserVisibilitySet",
      "evaluate",
    ]);
    // workspace 身份沿命令透传（scope 边界复用既有链路）。
    const evaluateCall = state.calls.find((call) => call.command.method === "evaluate");
    assert.ok(evaluateCall);
    assert.equal(evaluateCall.workspaceKey, "wk");
    assert.equal(evaluateCall.workspacePath, "/w");
    assert.equal(evaluateCall.workspaceIdentity, "wi");
    const drainCommand = evaluateCall.command as Extract<BrowserCommand, { method: "evaluate" }>;
    assert.equal(drainCommand.tabId, "tab-1");
    assert.ok(drainCommand.expression.includes("__zcodeAutomationCapture"));
    const visible = state.calls.find(
      (call) =>
        call.command.method === "browserVisibilitySet" &&
        call.command.visible === true &&
        state.calls.indexOf(call) < 4,
    );
    assert.ok(visible, "browser must be made visible for user interaction");
  } finally {
    await handle.cancel();
  }
});

test("URL 变化补 navigate 事件并排在同批新页面事件之前", async () => {
  const { port, state } = makeFakePort();
  // 首次 drain（安装）：url 与 newTab 基线一致，不产生 navigate。
  state.evaluateQueue.push(okResult({ value: { url: "about:blank", events: [] } }));
  const handle = await startAutomationCaptureSession(baseDeps(port));
  try {
    assert.equal(handle.state().eventCount, 0);
    // 下一轮 drain：URL 变化 + 新文档事件 → navigate 排在 click 之前。
    state.evaluateQueue.push(
      okResult({
        value: {
          url: "https://example.test/",
          events: [{ type: "click", ts: 5_000, selector: "#a", x: 1, y: 2 }],
        },
      }),
    );
    await sleep(60);
    const snapshot = handle.state();
    assert.equal(snapshot.lastUrl, "https://example.test/");
    assert.equal(snapshot.eventCount, 2);
    assert.equal(snapshot.stepCount, 2);
    const steps = await handle.stop();
    assert.deepEqual(
      steps.map((step) => step.action),
      ["navigate", "click"],
    );
    assert.equal(steps[0].value, "https://example.test/");
  } finally {
    await handle.cancel().catch(() => undefined);
  }
});

test("drain 失败只告警不终止，后续轮询恢复采集", async () => {
  const { port, state } = makeFakePort();
  state.evaluateQueue.push(
    errorResult("execution_error", "context destroyed"),
    okResult({
      value: {
        url: "https://example.test/",
        events: [{ type: "change", ts: 100, selector: "#q", value: "hi" }],
      },
    }),
  );
  const handle = await startAutomationCaptureSession(baseDeps(port));
  try {
    await sleep(80);
    assert.ok(handle.state().eventCount >= 2, "navigate + change 应已被采集");
  } finally {
    await handle.cancel();
  }
});

test("stop 最终 drain + 释放（可见性复位 + close scope tabs）", async () => {
  const { port, state } = makeFakePort();
  // 固定时钟：无事件 drain 的 navigate 事件取 now()，须与页面事件 ts 同源排序。
  const fakeNow = 1_000_000;
  state.evaluateQueue.push(okResult({ value: { url: "https://example.test/", events: [] } }));
  const handle = await startAutomationCaptureSession({
    ...baseDeps(port),
    now: () => fakeNow,
  });
  // URL 已在安装 drain 变化 → navigate 已入列；最终 drain 再补一条 type。
  state.evaluateQueue.push(
    okResult({
      value: {
        url: "https://example.test/",
        events: [{ type: "change", ts: fakeNow + 500, selector: "#q", value: "hello" }],
      },
    }),
  );
  const steps = await handle.stop();
  assert.deepEqual(
    steps.map((step) => step.action),
    ["navigate", "type"],
  );
  const methods = state.calls.map((call) => call.command.method);
  // 释放顺序：stop 内先收可见性复位，再 list+close。
  const hideIndex = methods.lastIndexOf("browserVisibilitySet");
  const lastListIndex = methods.length - 1 - [...methods].reverse().indexOf("list");
  assert.ok(methods.lastIndexOf("close") > lastListIndex, "scope tabs must be closed");
  assert.ok(hideIndex < methods.lastIndexOf("close"), "visibility must be reset before close");
  const hide = state.calls[hideIndex];
  assert.equal(hide.command.method === "browserVisibilitySet" && hide.command.visible, false);
  assert.equal(state.tabs.length, 0, "scope tab 应已全部关闭");
});

test("close 失败不阻断释放（尽力而为语义）", async () => {
  const { port, state } = makeFakePort();
  state.closeFailures = 1;
  const handle = await startAutomationCaptureSession(baseDeps(port));
  await assert.doesNotReject(handle.cancel());
  assert.ok(
    state.calls.some((call) => call.command.method === "close"),
    "close 命令必须派发过",
  );
});

test("cancel 不做最终 drain，直接释放", async () => {
  const { port, state } = makeFakePort();
  state.evaluateQueue.push(okResult({ value: { url: "about:blank", events: [] } }));
  const handle = await startAutomationCaptureSession(baseDeps(port));
  const evaluateBefore = state.evaluateCount;
  await handle.cancel();
  // 释放只派发 visibility/list/close；evaluate 数量不应因 cancel 增加。
  assert.equal(state.evaluateCount, evaluateBefore);
  assert.ok(state.calls.some((call) => call.command.method === "close"));
});

test("state 反映会话元数据与映射步数", async () => {
  const { port, state } = makeFakePort();
  state.evaluateQueue.push(
    okResult({
      value: {
        url: "https://example.test/",
        events: [
          { type: "click", ts: 1_000, selector: "#a", x: 1, y: 2 },
          { type: "click", ts: 1_200, selector: "#a", x: 1, y: 2 },
        ],
      },
    }),
  );
  const handle = await startAutomationCaptureSession(baseDeps(port));
  try {
    await sleep(60);
    const snapshot = handle.state();
    assert.equal(snapshot.captureId, "cap-test-1");
    assert.equal(snapshot.sessionId, "automation-record:cap-test-1");
    assert.ok(Number.isFinite(Date.parse(snapshot.startedAt)), "startedAt 必须是 ISO 时间");
    assert.equal(snapshot.lastUrl, "https://example.test/");
    // 连击合并后：navigate + 1 click = 2 步；事件层 3 条。
    assert.equal(snapshot.stepCount, 2);
    assert.equal(snapshot.eventCount, 3);
  } finally {
    await handle.cancel();
  }
});
