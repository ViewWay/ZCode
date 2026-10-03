// zwidget 沙箱安全用例（specs/deliverable-cards.md，必须全绿才可发布）：
// - iframe sandbox 属性断言：仅 allow-scripts，绝不含 allow-same-origin。
// - CSP 断言：default-src 'none' / connect-src 'none'，srcDoc 文档强制带 CSP meta。
// - 静态检测拒绝：require / electron / process.* / 父窗口 DOM / 外部资源 → 拒绝渲染。
// - 围栏提取与 2MB 大小上限。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test packages/ui/test/zwidgetSandbox.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildZWidgetSandboxDocument,
  extractZWidgetBlocks,
  getZWidgetHtmlByteLength,
  isZWidgetHtmlWithinSizeLimit,
  scanZWidgetHtml,
  ZWIDGET_FENCE_LANGUAGE,
  ZWIDGET_HTML_MAX_BYTES,
  ZWIDGET_IFRAME_CSP,
  ZWIDGET_IFRAME_SANDBOX,
} from "@zcode/shared";

// ── iframe sandbox 属性断言 ────────────────────────────────────

test("widget iframe sandbox grants scripts only and never same-origin", () => {
  assert.equal(ZWIDGET_IFRAME_SANDBOX, "allow-scripts");
  // allow-same-origin 会让 widget 与宿主同源，父窗口 DOM 直接可达——绝对禁止。
  assert.equal(ZWIDGET_IFRAME_SANDBOX.includes("allow-same-origin"), false);
  assert.equal(ZWIDGET_IFRAME_SANDBOX.includes("allow-top-navigation"), false);
});

test("widget CSP forbids all network and external loads", () => {
  assert.match(ZWIDGET_IFRAME_CSP, /default-src 'none'/);
  assert.match(ZWIDGET_IFRAME_CSP, /connect-src 'none'/);
  // 自包含场景只允许内联脚本/样式与 data:/blob: 资源。
  assert.match(ZWIDGET_IFRAME_CSP, /script-src 'unsafe-inline'/);
  assert.match(ZWIDGET_IFRAME_CSP, /style-src 'unsafe-inline'/);
  assert.equal(/https?:/.test(ZWIDGET_IFRAME_CSP), false);
});

test("sandbox document always carries the CSP meta before any script", () => {
  for (const html of [
    "<button onclick=\"this.textContent='ok'\">click</button>",
    "<html><head><title>t</title></head><body><script>1<\\/script></body></html>",
  ]) {
    const doc = buildZWidgetSandboxDocument(html);
    assert.match(doc, /http-equiv="Content-Security-Policy"/);
    assert.match(doc, /default-src 'none'/);
    // CSP meta 必须出现在第一个 <script> 之前（否则内联脚本先执行、CSP 后生效）。
    const cspIndex = doc.indexOf("Content-Security-Policy");
    const scriptIndex = doc.search(/<script/i);
    assert.ok(cspIndex >= 0 && (scriptIndex === -1 || cspIndex < scriptIndex));
  }
});

// ── 静态检测拒绝（防御纵深第二层） ────────────────────────────

test("widget referencing require/electron/node bridges is rejected", () => {
  for (const hostile of [
    "<script>const fs = require('fs');<\\/script>",
    "<script>window.require('electron')<\\/script>",
    "<script>const { app } = require('electron');<\\/script>",
    "<script>if (process.versions.electron) alert(1)<\\/script>",
    "<script>module.exports = {}<\\/script>",
  ]) {
    const scan = scanZWidgetHtml(hostile.replace(/<\\\//g, "</"));
    assert.equal(scan.ok, false, `should reject: ${hostile}`);
    assert.equal(scan.rule, "node-bridge");
  }
});

test("widget touching parent/top window DOM is rejected", () => {
  for (const hostile of [
    "<script>window.parent.document.body.innerHTML = 'pwn'<\\/script>",
    "<script>top.location = 'https://evil.example'<\\/script>",
    "<script>parent.window.postMessage('x', '*')<\\/script>",
    "<script>const f = window.frameElement<\\/script>",
  ]) {
    const scan = scanZWidgetHtml(hostile.replace(/<\\\//g, "</"));
    assert.equal(scan.ok, false, `should reject: ${hostile}`);
    assert.equal(scan.rule, "parent-access");
  }
});

test("widget loading external resources or fetching is rejected", () => {
  for (const hostile of [
    '<script src="https://evil.example/p.js"><\\/script>',
    '<img src="https://evil.example/pixel.png">',
    '<link rel="stylesheet" href="//evil.example/s.css">',
    "<script>fetch('https://evil.example/x')<\\/script>",
    "<script>new WebSocket('wss://evil.example')<\\/script>",
  ]) {
    const scan = scanZWidgetHtml(hostile.replace(/<\\\//g, "</"));
    assert.equal(scan.ok, false, `should reject: ${hostile}`);
    assert.equal(scan.rule, "external-resource");
  }
});

test("benign self-contained interactive widget passes the scan", () => {
  const benign = `<!doctype html>
<html>
<head><title>Slider demo</title></head>
<body>
  <input id="s" type="range" min="1" max="10" value="5">
  <canvas id="c" width="300" height="200"></canvas>
  <script>
    const slider = document.getElementById('s');
    const canvas = document.getElementById('c');
    slider.addEventListener('input', () => {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, 300, 200);
      ctx.fillRect(10, 10, slider.value * 20, 50);
    });
  </script>
</body>
</html>`;
  assert.deepEqual(scanZWidgetHtml(benign), { ok: true });
});

// ── 围栏提取与大小预算 ────────────────────────────────────────

test("zwidget fences are extracted with optional titles", () => {
  const markdown = [
    "Here is a demo:",
    "```zwidget",
    "<html><head><title>Chart</title></head><body><canvas></canvas></body></html>",
    "```",
    "```html",
    "<p>not a widget</p>",
    "```",
  ].join("\n");
  const blocks = extractZWidgetBlocks(markdown);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.kind, "zwidget");
  assert.equal(blocks[0]?.title, "Chart");
  assert.match(blocks[0]?.html ?? "", /<canvas>/);
});

test("unterminated zwidget fences are ignored until closed", () => {
  const streaming = "```zwidget\n<div>still streaming";
  assert.deepEqual(extractZWidgetBlocks(streaming), []);
});

test("zwidget html over the 2MB budget is rejected before render", () => {
  // "x" 的 UTF-8 编码是 1 字节，正好构造精确边界。
  const withinLimit = "x".repeat(ZWIDGET_HTML_MAX_BYTES);
  assert.equal(getZWidgetHtmlByteLength(withinLimit), ZWIDGET_HTML_MAX_BYTES);
  assert.equal(isZWidgetHtmlWithinSizeLimit(withinLimit), true);
  const overLimit = withinLimit + "x";
  assert.equal(isZWidgetHtmlWithinSizeLimit(overLimit), false);
});

test("zwidget fence language is the expected marker", () => {
  assert.equal(ZWIDGET_FENCE_LANGUAGE, "zwidget");
});
