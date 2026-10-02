import {
  automationCaptureDrainResultSchema,
  type AutomationCaptureDrainResult,
} from "@zcode/shared";

/**
 * 实时采集页面脚本（specs/record-replay.md v1.1）。
 *
 * - 单条 evaluate 表达式同时完成「安装（幂等）+ drain」：脚本不存在时安装监听并返回
 *   空事件，存在时取走缓冲事件。host 每个轮询周期派发一次，导航销毁文档后下次
 *   轮询自动重装。
 * - 只监听主框架；click（capture，记录视口坐标 + 尽力 selector）、change（表单提交值，
 *   含敏感文本，录制前 UI 已明示）、wheel（500ms 空闲去抖聚合 deltaY）、
 *   popstate/hashchange（SPA 导航）。缓冲上限 500 条/文档，超出丢弃（采集尽力而为）。
 * - 页面脚本禁反引号与 ${}（browserCommandScripts 约定），全部用字符串拼接。
 */

/** 页面事件缓冲上限；与 shared drain schema 的 events 上限一致。 */
export const CAPTURE_PAGE_BUFFER_LIMIT = 500;

/** 页面侧 wheel 聚合的空闲窗口：最后一次 wheel 后静默该时长才产出一条 scroll 事件。 */
const PAGE_SCROLL_IDLE_MS = 500;

/**
 * 自安装 drain 表达式。经 evaluate 派发；返回 { url, events }。
 * 注意：表达式会被包进 `return ( <expr> )`（EVALUATE_SCRIPT），保持单表达式形态。
 */
export function buildAutomationCaptureDrainExpression(): string {
  return `(function () {
  var KEY = '__zcodeAutomationCapture';
  var MAX_EVENTS = ${CAPTURE_PAGE_BUFFER_LIMIT};
  var SCROLL_IDLE_MS = ${PAGE_SCROLL_IDLE_MS};
  var state = window[KEY];
  if (!state) {
    var buffer = [];
    var push = function (event) {
      if (buffer.length < MAX_EVENTS) buffer.push(event);
    };
    var now = function () { return Date.now(); };
    var attr = function (value) {
      try { return JSON.stringify(String(value)); } catch (err) { return '""'; }
    };
    var unique = function (css) {
      try { return document.querySelectorAll(css).length === 1; } catch (err) { return false; }
    };
    var isIdent = function (text) { return /^[A-Za-z0-9_-]+$/.test(text); };
    // 尽力构造回放可用 selector：id > data-testid > name > 短 CSS 路径（nth-of-type）。
    // 构造失败返回 null，调用方回退坐标（click）或丢弃（change 无 selector 不可回放）。
    var selectorFor = function (el) {
      if (!el || el.nodeType !== 1) return null;
      var id = el.getAttribute && el.getAttribute('id');
      if (id && isIdent(id)) {
        var idCss = '#' + id;
        if (unique(idCss)) return idCss;
      }
      var testid = el.getAttribute && el.getAttribute('data-testid');
      if (testid) {
        var testCss = '[data-testid=' + attr(testid) + ']';
        if (unique(testCss)) return testCss;
      }
      var name = el.getAttribute && el.getAttribute('name');
      if (name) {
        var nameCss = '[name=' + attr(name) + ']';
        if (unique(nameCss)) return nameCss;
      }
      var parts = [];
      var node = el;
      var depth = 0;
      while (node && node.nodeType === 1 && depth < 4) {
        var tag = node.nodeName.toLowerCase();
        var index = 1;
        var sibling = node;
        while (sibling = sibling.previousElementSibling) {
          if (sibling.nodeName === node.nodeName) index += 1;
        }
        parts.unshift(index > 1 ? tag + ':nth-of-type(' + index + ')' : tag);
        node = node.parentElement;
        depth += 1;
      }
      var path = parts.join(' > ');
      if (path && path.length <= 2000 && unique(path)) return path;
      return null;
    };
    var scrollSum = 0;
    var scrollTimer = null;
    var flushScroll = function () {
      if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = null; }
      if (scrollSum !== 0) {
        var delta = Math.max(-100000, Math.min(100000, Math.round(scrollSum)));
        scrollSum = 0;
        push({ type: 'scroll', ts: now(), deltaY: delta });
      }
    };
    var pushNavigate = function () {
      var url = String(location.href || '');
      if (url) push({ type: 'navigate', ts: now(), url: url });
    };
    var targetElement = function (event) {
      var target = event.target;
      if (target && target.nodeType === 1) return target;
      if (target && target.parentElement) return target.parentElement;
      return null;
    };
    document.addEventListener('click', function (event) {
      var el = targetElement(event);
      var selector = el ? selectorFor(el) : null;
      push({ type: 'click', ts: now(), x: Math.round(event.clientX || 0), y: Math.round(event.clientY || 0), ...(selector ? { selector: selector } : {}) });
    }, true);
    document.addEventListener('change', function (event) {
      var el = targetElement(event);
      if (!el) return;
      var tag = el.nodeName && el.nodeName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
      var selector = selectorFor(el);
      if (!selector) return;
      var value = el.value === undefined ? '' : String(el.value);
      if (value.length > 100000) value = value.slice(0, 100000);
      push({ type: 'change', ts: now(), selector: selector, value: value });
    }, true);
    window.addEventListener('wheel', function (event) {
      scrollSum += event.deltaY || 0;
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(flushScroll, SCROLL_IDLE_MS);
    }, { passive: true, capture: true });
    window.addEventListener('popstate', pushNavigate);
    window.addEventListener('hashchange', pushNavigate);
    window.addEventListener('pagehide', flushScroll);
    state = { buffer: buffer };
    try { Object.defineProperty(window, KEY, { value: state, configurable: false }); }
    catch (err) { window[KEY] = state; }
  }
  var drained = state.buffer.splice(0, MAX_EVENTS);
  return { url: String(location.href || ''), events: drained };
})()`;
}

/**
 * 校验 drain 返回值。数据来自不可信页面上下文，schema 不通过即抛错
 * （调用方按轮询失败处理：告警 + 下轮重试），不做部分采纳。
 */
export function parseAutomationCaptureDrainResult(value: unknown): AutomationCaptureDrainResult {
  const result = automationCaptureDrainResultSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`invalid capture drain result: ${result.error.message}`);
  }
  return result.data;
}
