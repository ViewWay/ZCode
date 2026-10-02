// A5 回放引擎单测（specs/record-replay.md）：逐步顺序、失败中断/跳过策略、报告内容、wait 本地延时。
import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationRecording, AutomationRecordingStep } from "@zcode/shared";
import { createAutomationReplayEngine } from "../../src/host/automationReplayEngine.js";
import type { BrowserActionExecutor } from "../../src/host/automationReplayExecutors.js";

interface FakeExecutorCall {
  kind: "step" | "screenshot";
  seq?: number;
}

/** 可编排结果的假执行器：按 seq 决定成败；截图固定返回 base64。 */
function createFakeExecutor(options: {
  failSeqs?: number[];
  screenshot?: { ok: true; base64Png: string } | { ok: false; error: string };
  surface?: string;
}): { executor: BrowserActionExecutor; calls: FakeExecutorCall[] } {
  const calls: FakeExecutorCall[] = [];
  const executor: BrowserActionExecutor = {
    surface: options.surface ?? "fake",
    async executeStep(step) {
      calls.push({ kind: "step", seq: step.seq });
      if (options.failSeqs?.includes(step.seq)) {
        return { ok: false, error: "selector_not_found: #submit" };
      }
      return { ok: true };
    },
    async captureScreenshot() {
      calls.push({ kind: "screenshot" });
      const shot = options.screenshot ?? { ok: true, base64Png: "aGVsbG8=" };
      return shot.ok ? { ok: true, base64Png: shot.base64Png } : { ok: false, error: shot.error };
    },
  };
  return { executor, calls };
}

function makeRecording(steps: AutomationRecordingStep[]): AutomationRecording {
  return {
    id: "rec-test",
    createdAt: "2026-01-01T00:00:00.000Z",
    source: "browser",
    steps,
  };
}

function createHarness(executor: BrowserActionExecutor) {
  const savedScreenshots: Array<{ recordingId: string; runId: string; seq: number }> = [];
  const savedReports: AutomationRecording["id"][] = [];
  let tick = 0;
  const delays: number[] = [];
  const engine = createAutomationReplayEngine({
    executor,
    sink: {
      async saveScreenshot(recordingId, runId, seq) {
        savedScreenshots.push({ recordingId, runId, seq });
        return `/reports/${recordingId}/${runId}-step-${seq}.png`;
      },
      async saveReport(report) {
        savedReports.push(report.recordingId);
        return `/reports/${report.recordingId}/${report.runId}.json`;
      },
    },
    now: () => tick++,
    newRunId: () => "run-fixed",
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  return { engine, savedScreenshots, savedReports, delays };
}

test("全部成功：按 seq 升序执行，wait 不派发执行器，报告 completed", async () => {
  const { executor, calls } = createFakeExecutor({});
  const { engine, savedScreenshots, savedReports, delays } = createHarness(executor);
  // steps 数组故意乱序，引擎必须按 seq 排序执行。
  const result = await engine.replay(
    makeRecording([
      { seq: 3, action: "wait", durationMs: 250 },
      { seq: 1, action: "navigate", value: "https://example.test/" },
      { seq: 2, action: "type", target: { kind: "selector", selector: "#q" }, value: "hi" },
    ]),
    "abort",
  );

  assert.deepEqual(
    calls.map((call) => call.seq),
    [1, 2],
  );
  assert.deepEqual(delays, [250]);
  assert.equal(result.report.status, "completed");
  assert.equal(result.report.runId, "run-fixed");
  assert.equal(result.report.executorSurface, "fake");
  assert.deepEqual(
    result.report.steps.map((step) => [step.seq, step.status]),
    [
      [1, "succeeded"],
      [2, "succeeded"],
      [3, "succeeded"],
    ],
  );
  assert.deepEqual(savedScreenshots, []);
  assert.deepEqual(savedReports, ["rec-test"]);
  assert.equal(result.reportPath, "/reports/rec-test/run-fixed.json");
});

test("失败默认 abort：失败步附截图并中断，剩余步骤不执行也不进报告", async () => {
  const { executor, calls } = createFakeExecutor({ failSeqs: [2] });
  const { engine, savedScreenshots } = createHarness(executor);
  const result = await engine.replay(
    makeRecording([
      { seq: 1, action: "navigate", value: "https://example.test/" },
      { seq: 2, action: "click", target: { kind: "selector", selector: "#submit" } },
      { seq: 3, action: "scroll", deltaY: 300 },
    ]),
    "abort",
  );

  // 步骤 3 从未派发。
  assert.deepEqual(
    calls.filter((call) => call.kind === "step").map((call) => call.seq),
    [1, 2],
  );
  assert.equal(result.report.status, "failed");
  assert.equal(result.report.steps.length, 2);
  const failedStep = result.report.steps[1];
  assert.equal(failedStep?.status, "failed");
  assert.match(failedStep?.error ?? "", /selector_not_found/u);
  assert.equal(failedStep?.screenshotPath, "/reports/rec-test/run-fixed-step-2.png");
  assert.deepEqual(savedScreenshots, [{ recordingId: "rec-test", runId: "run-fixed", seq: 2 }]);
});

test("失败策略 skip：失败步记 skipped 并继续执行后续步骤", async () => {
  const { executor, calls } = createFakeExecutor({ failSeqs: [2] });
  const { engine } = createHarness(executor);
  const result = await engine.replay(
    makeRecording([
      { seq: 1, action: "navigate", value: "https://example.test/" },
      { seq: 2, action: "click", target: { kind: "selector", selector: "#submit" } },
      { seq: 3, action: "extract" },
    ]),
    "skip",
  );

  assert.deepEqual(
    calls.filter((call) => call.kind === "step").map((call) => call.seq),
    [1, 2, 3],
  );
  // skip 下无 failed 步 → 整体 completed；失败步保留 skipped 状态与原因。
  assert.equal(result.report.status, "completed");
  assert.deepEqual(
    result.report.steps.map((step) => step.status),
    ["succeeded", "skipped", "succeeded"],
  );
  assert.match(result.report.steps[1]?.error ?? "", /selector_not_found/u);
});

test("截图不可用：失败步仍记录，error 附截图失败说明", async () => {
  const { executor } = createFakeExecutor({
    failSeqs: [1],
    screenshot: { ok: false, error: "page crashed" },
  });
  const { engine, savedScreenshots } = createHarness(executor);
  const result = await engine.replay(
    makeRecording([{ seq: 1, action: "navigate", value: "https://example.test/" }]),
    "abort",
  );

  assert.equal(result.report.status, "failed");
  assert.equal(result.report.steps[0]?.screenshotPath, undefined);
  assert.match(result.report.steps[0]?.error ?? "", /screenshot unavailable \(page crashed\)/u);
  assert.deepEqual(savedScreenshots, []);
});

test("unavailable 执行面：每步诚实失败，报告 failed 且 surface 说明原因", async () => {
  const { executor } = createFakeExecutor({
    surface: "unavailable: not wired",
    failSeqs: [1, 2],
  });
  const { engine } = createHarness(executor);
  const result = await engine.replay(
    makeRecording([
      { seq: 1, action: "navigate", value: "https://example.test/" },
      { seq: 2, action: "extract" },
    ]),
    "abort",
  );

  assert.equal(result.report.status, "failed");
  assert.equal(result.report.executorSurface, "unavailable: not wired");
  assert.equal(result.report.steps.length, 1);
  assert.match(result.report.steps[0]?.error ?? "", /selector_not_found/u);
});
