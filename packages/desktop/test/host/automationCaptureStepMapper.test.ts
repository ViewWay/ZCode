// A5 实时采集步骤映射单测（specs/record-replay.md v1.1）：连击合并、同字段取后值、
// scroll 同向聚合、长间隔插 wait、截断与乱序输入。产出步骤用 shared 的
// step schema 收口校验，保证映射结果可直接进入 store.save。
import assert from "node:assert/strict";
import test from "node:test";
import {
  automationRecordingSchema,
  automationRecordingStepSchema,
  type AutomationCaptureRawEvent,
} from "@zcode/shared";
import {
  mapCaptureEventsToSteps,
  resolveCaptureMappingOptions,
} from "../../src/host/automationCaptureStepMapper.js";

function click(ts: number, selector?: string, x = 10, y = 20): AutomationCaptureRawEvent {
  return selector ? { type: "click", ts, selector, x, y } : { type: "click", ts, x, y };
}

function validateSteps(steps: ReturnType<typeof mapCaptureEventsToSteps>): void {
  for (const step of steps) {
    // 单步 schema 校验（action 必填字段由 superRefine 在 recording 层收口，这里校验基础结构）。
    const result = automationRecordingStepSchema.safeParse(step);
    assert.ok(result.success, `step must satisfy schema: ${JSON.stringify(step)}`);
  }
}

test("navigate + click(selector) + change + scroll 依次映射并分配连续 seq", () => {
  const steps = mapCaptureEventsToSteps([
    { type: "navigate", ts: 1_000, url: "https://example.test/" },
    click(2_500, "#submit"),
    { type: "change", ts: 3_000, selector: "#name", value: "hello" },
    { type: "scroll", ts: 3_100, deltaY: -300 },
  ]);
  assert.deepEqual(
    steps.map((step) => step.action),
    ["navigate", "click", "type", "scroll"],
  );
  assert.deepEqual(
    steps.map((step) => step.seq),
    [1, 2, 3, 4],
  );
  assert.equal(steps[0].value, "https://example.test/");
  assert.deepEqual(steps[1].target, { kind: "selector", selector: "#submit" });
  assert.equal(steps[2].value, "hello");
  assert.equal(steps[3].deltaY, -300);
  validateSteps(steps);
});

test("同 selector 连击在窗口内合并，窗口外保留", () => {
  const window = resolveCaptureMappingOptions().clickMergeWindowMs;
  const steps = mapCaptureEventsToSteps([
    click(1_000, "#btn"),
    click(1_000 + 200, "#btn"),
    click(1_000 + window + 100, "#btn"),
  ]);
  // 前两次间隔 200ms < 500ms 合并；第三次间隔超窗保留。
  assert.equal(steps.filter((step) => step.action === "click").length, 2);
});

test("坐标点击（无 selector）合并抖动并回退 point 目标", () => {
  const steps = mapCaptureEventsToSteps([
    click(1_000, undefined, 100, 200),
    click(1_200, undefined, 103, 202),
    click(1_300, undefined, 400, 400),
  ]);
  const clicks = steps.filter((step) => step.action === "click");
  // (100,200) 与 (103,202) 同 8px 网格且间隔 200ms 合并；(400,400) 保留。
  assert.equal(clicks.length, 2);
  assert.deepEqual(clicks[0].target, { kind: "point", x: 100, y: 200 });
});

test("同字段连续 change 取后值", () => {
  const steps = mapCaptureEventsToSteps([
    { type: "change", ts: 1_000, selector: "#q", value: "h" },
    { type: "change", ts: 1_200, selector: "#q", value: "hello world" },
  ]);
  const types = steps.filter((step) => step.action === "type");
  assert.equal(types.length, 1);
  assert.equal(types[0].value, "hello world");
});

test("同向相邻 scroll 聚合求和，反向分开", () => {
  const steps = mapCaptureEventsToSteps([
    { type: "scroll", ts: 1_000, deltaY: 500 },
    { type: "scroll", ts: 1_400, deltaY: 300 },
    { type: "scroll", ts: 1_800, deltaY: -200 },
  ]);
  const scrolls = steps.filter((step) => step.action === "scroll");
  assert.equal(scrolls.length, 2);
  assert.equal(scrolls[0].deltaY, 800);
  assert.equal(scrolls[1].deltaY, -200);
});

test("相邻步骤间隔超阈值插入 wait，超上限封顶", () => {
  const steps = mapCaptureEventsToSteps([
    click(1_000, "#a"),
    click(3_500, "#b"),
    click(3_500 + 70_000, "#c"),
  ]);
  const actions = steps.map((step) => step.action);
  assert.deepEqual(actions, ["click", "wait", "click", "wait", "click"]);
  const waits = steps.filter((step) => step.action === "wait");
  assert.equal(waits[0].durationMs, 2_500);
  assert.equal(waits[1].durationMs, 60_000);
});

test("首步之前不插入 wait（回放从头执行，无等待语义）", () => {
  const steps = mapCaptureEventsToSteps([click(100_000, "#a")]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].action, "click");
});

test("乱序输入按 ts 排序后映射", () => {
  const steps = mapCaptureEventsToSteps([click(2_500, "#second"), click(1_000, "#first")]);
  const clicks = steps.filter((step) => step.action === "click");
  assert.deepEqual(
    clicks.map((step) => (step.target as { selector: string }).selector),
    ["#first", "#second"],
  );
  assert.deepEqual(
    steps.map((step) => step.seq),
    [1, 2],
  );
});

test("步骤总数超过 maxSteps 截断", () => {
  const events: AutomationCaptureRawEvent[] = [];
  for (let index = 0; index < 6; index += 1) {
    events.push(click(1_000 + index * 10_000, `#btn-${index}`));
  }
  const steps = mapCaptureEventsToSteps(events, { maxSteps: 3, waitStepMinMs: 10_000 });
  assert.equal(steps.length, 3);
  assert.deepEqual(
    steps.map((step) => step.seq),
    [1, 2, 3],
  );
});

test("scroll 聚合值截断到 schema 上限", () => {
  const steps = mapCaptureEventsToSteps([
    { type: "scroll", ts: 1_000, deltaY: 90_000 },
    { type: "scroll", ts: 1_200, deltaY: 90_000 },
  ]);
  const scrolls = steps.filter((step) => step.action === "scroll");
  assert.equal(scrolls.length, 1);
  assert.equal(scrolls[0].deltaY, 100_000);
  validateSteps(steps);
});

test("映射结果可组装为合法 recording（store.save 的全量 schema 收口）", () => {
  const steps = mapCaptureEventsToSteps([
    { type: "navigate", ts: 1_000, url: "https://example.test/" },
    click(2_500, "#submit"),
    { type: "change", ts: 3_000, selector: "#name", value: "hello" },
    { type: "scroll", ts: 6_000, deltaY: -300 },
  ]);
  const recording = automationRecordingSchema.parse({
    id: "rec-test",
    title: "采集",
    createdAt: new Date(0).toISOString(),
    source: "browser",
    steps,
  });
  assert.equal(recording.steps.length, 5, "长间隔应插入 wait：navigate/click/type/wait/scroll");
  assert.equal(recording.steps[3].action, "wait");
});
