// A5 实时采集页面脚本单测（specs/record-replay.md v1.1）：drain 表达式遵循页面脚本
// 约定（无反引号/${}）且可被 JS 解析；drain 返回值经 Zod 校验，非法数据整体拒绝。
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAutomationCaptureDrainExpression,
  parseAutomationCaptureDrainResult,
} from "../../src/host/automationCaptureEvents.js";

test("drain 表达式不含反引号与 ${}（页面脚本约定）", () => {
  const expression = buildAutomationCaptureDrainExpression();
  assert.ok(!expression.includes("`"), "expression must not contain backticks");
  assert.ok(!expression.includes("${"), "expression must not contain template placeholders");
});

test("drain 表达式是可解析的 JS 表达式（EVALUATE_SCRIPT 包裹形态）", () => {
  const expression = buildAutomationCaptureDrainExpression();
  // 模拟 browserCommandScripts EVALUATE_SCRIPT 的包裹方式；只验证语法，不执行（无 DOM）。
  const wrapped = new Function(`return ( ${expression} );`);
  assert.equal(typeof wrapped, "function");
});

test("合法 drain 结果解析为事件数组", () => {
  const parsed = parseAutomationCaptureDrainResult({
    url: "https://example.test/",
    events: [
      { type: "click", ts: 1_000, selector: "#btn", x: 10, y: 20 },
      { type: "change", ts: 1_500, selector: "#q", value: "text" },
      { type: "scroll", ts: 2_000, deltaY: -240 },
      { type: "navigate", ts: 3_000, url: "https://example.test/page" },
    ],
  });
  assert.equal(parsed.url, "https://example.test/");
  assert.equal(parsed.events.length, 4);
  assert.deepEqual(parsed.events[0], { type: "click", ts: 1_000, selector: "#btn", x: 10, y: 20 });
});

test("click 缺坐标、change 缺 selector、未知字段、非对象输入均整体拒绝", () => {
  assert.throws(() =>
    parseAutomationCaptureDrainResult({
      url: "https://example.test/",
      events: [{ type: "click", ts: 1_000, selector: "#btn" }],
    }),
  );
  assert.throws(() =>
    parseAutomationCaptureDrainResult({
      url: "https://example.test/",
      events: [{ type: "change", ts: 1_000, value: "x" }],
    }),
  );
  assert.throws(() =>
    parseAutomationCaptureDrainResult({
      url: "https://example.test/",
      events: [{ type: "click", ts: 1_000, x: 1, y: 2, extra: true }],
    }),
  );
  assert.throws(() => parseAutomationCaptureDrainResult(null));
  assert.throws(() => parseAutomationCaptureDrainResult("nope"));
});

test("events 超过 500 条拒绝（页面缓冲上限对账）", () => {
  const events = Array.from({ length: 501 }, (_, index) => ({
    type: "scroll",
    ts: index + 1,
    deltaY: 10,
  }));
  assert.throws(() => parseAutomationCaptureDrainResult({ url: "https://example.test/", events }));
});

test("click 无 selector（坐标回退）合法", () => {
  const parsed = parseAutomationCaptureDrainResult({
    url: "https://example.test/",
    events: [{ type: "click", ts: 1_000, x: 5, y: 6 }],
  });
  assert.equal(parsed.events[0].type, "click");
});
