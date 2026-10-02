// A5 执行面单测（specs/record-replay.md）：步骤→BrowserCommand 映射、派发结果归一、no-op 执行面诚实失败。
import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserCommand, BrowserCommandResult } from "@zcode/shared";
import {
  automationRecordingStepToBrowserCommand,
  createBrowserCommandActionExecutor,
  createUnavailableBrowserActionExecutor,
  type BrowserCommandDispatcher,
} from "../../src/host/automationReplayExecutors.js";

function okResult(partial: Partial<BrowserCommandResult> = {}): BrowserCommandResult {
  return { ok: true, elapsedMs: 1, ...partial };
}

function errorResult(message: string): BrowserCommandResult {
  return { ok: false, elapsedMs: 1, error: { code: "execution_error", message } };
}

/** 断言 playwright locator 命令的关键字段；非 locator 命令直接 fail。 */
function expectLocator(command: BrowserCommand | null): asserts command is Extract<
  BrowserCommand,
  { method: "playwright" }
> & {
  action: { name: "locator" };
} {
  assert.ok(command, "expected a mapped command");
  assert.equal(command.method, "playwright");
  if (command.method !== "playwright" || command.action.name !== "locator") {
    assert.fail(`expected playwright locator action, got ${JSON.stringify(command)}`);
  }
}

test("navigate 映射 navigate URL", () => {
  assert.deepEqual(
    automationRecordingStepToBrowserCommand({
      seq: 1,
      action: "navigate",
      value: "https://example.test/",
    }),
    { method: "navigate", url: "https://example.test/" },
  );
});

test("type(selector) 映射 playwright locator fill", () => {
  const command = automationRecordingStepToBrowserCommand({
    seq: 2,
    action: "type",
    target: { kind: "selector", selector: "#q" },
    value: "hello",
  });
  expectLocator(command);
  assert.equal(command.action.selector, "#q");
  assert.equal(command.action.operation, "fill");
  assert.equal(command.action.value, "hello");
});

test("click(selector) 映射 playwright locator click；click(point) 映射坐标 click", () => {
  const selectorClick = automationRecordingStepToBrowserCommand({
    seq: 3,
    action: "click",
    target: { kind: "selector", selector: "#submit" },
  });
  expectLocator(selectorClick);
  assert.equal(selectorClick.action.selector, "#submit");
  assert.equal(selectorClick.action.operation, "click");

  assert.deepEqual(
    automationRecordingStepToBrowserCommand({
      seq: 4,
      action: "click",
      target: { kind: "point", x: 120, y: 40 },
    }),
    { method: "click", x: 120, y: 40 },
  );
});

test("scroll 映射滚轮 deltaY；extract 映射 snapshot；wait 不映射", () => {
  assert.deepEqual(
    automationRecordingStepToBrowserCommand({ seq: 1, action: "scroll", deltaY: -400 }),
    { method: "scroll", y: -400 },
  );
  assert.deepEqual(automationRecordingStepToBrowserCommand({ seq: 2, action: "extract" }), {
    method: "snapshot",
  });
  // wait 由引擎本地延时，不进入执行面。
  assert.equal(
    automationRecordingStepToBrowserCommand({ seq: 3, action: "wait", durationMs: 10 }),
    null,
  );
});

test("派发结果归一：成功 ok，失败带 code+message，throw 不逃逸", async () => {
  const dispatched: string[] = [];
  const dispatcher: BrowserCommandDispatcher = async (command) => {
    dispatched.push(command.method);
    if (command.method === "snapshot") throw new Error("bridge gone");
    if (command.method === "screenshot") {
      return okResult({ image: { base64: "aGVsbG8=", mimeType: "image/png" } });
    }
    return command.method === "navigate" ? okResult() : errorResult("ref not found");
  };
  const executor = createBrowserCommandActionExecutor({ dispatcher });

  assert.deepEqual(await executor.executeStep({ seq: 1, action: "navigate", value: "u" }), {
    ok: true,
  });
  assert.deepEqual(await executor.executeStep({ seq: 2, action: "extract" }), {
    ok: false,
    error: "dispatch_failed: bridge gone",
  });
  assert.deepEqual(await executor.captureScreenshot(), { ok: true, base64Png: "aGVsbG8=" });
  assert.equal(executor.surface, "browser-command-bridge");
  assert.deepEqual(dispatched, ["navigate", "snapshot", "screenshot"]);
});

test("无图 screenshot 结果按失败归一", async () => {
  const dispatcher: BrowserCommandDispatcher = async () => errorResult("surface detached");
  const executor = createBrowserCommandActionExecutor({ dispatcher });
  const shot = await executor.captureScreenshot();
  assert.equal(shot.ok, false);
  assert.match(shot.error ?? "", /execution_error: surface detached/u);
});

test("unavailable 执行面：每步/截图都返回结构化 unavailable，绝不伪造成功", async () => {
  const executor = createUnavailableBrowserActionExecutor("not wired to a live browser session");
  assert.equal(executor.surface, "unavailable: not wired to a live browser session");
  assert.deepEqual(await executor.executeStep({ seq: 1, action: "extract" }), {
    ok: false,
    error: "unavailable: not wired to a live browser session",
  });
  const shot = await executor.captureScreenshot();
  assert.equal(shot.ok, false);
  assert.match(shot.error ?? "", /unavailable/u);
});
