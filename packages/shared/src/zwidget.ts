// ============================================================
// zwidget - 消息流内嵌交互组件的共享契约与纯函数（specs/deliverable-cards.md）
// ============================================================
// 对齐 MiMo 的 present_files + sci-widget 机制：
// - present_files：模型声明交付物文件（工具本体契约在 @zcode/contracts，这里只放
//   工具名单一事实源——UI 消息流与 CLI contracts 都以此拼装/匹配）。
// - zwidget：assistant 回复里的 ```zwidget 围栏块，渲染层提取后进 sandbox iframe
//   （无同源、无 node/electron 桥、无网络）。本文件只承载纯数据与纯函数，
//   供 renderer（packages/ui）与测试共享；不做任何 DOM/React 依赖。
// 大小上限（ZWIDGET_HTML_MAX_BYTES）是渲染层的硬拒绝线：超限不渲染、不清空
// 消息本体，只降级为提示。

/** present_files 工具名：contracts 工具契约与 UI 工具卡匹配共用。 */
export const PRESENT_FILES_TOOL_NAME = "present_files";

/** ```zwidget 围栏的语言标记。 */
export const ZWIDGET_FENCE_LANGUAGE = "zwidget";

/** 消息流 widget 块的 kind 判别值。 */
export const ZWIDGET_BLOCK_KIND = "zwidget";

/**
 * 单个 widget 的 HTML 大小上限（UTF-8 字节）。2MB 与 MiMo 同档：足够装下一个
 * 自包含图表/演示页，又不至于让一条消息把渲染面板撑爆。
 */
export const ZWIDGET_HTML_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 消息流 widget 块：由渲染层从 assistant 回复的 ```zwidget 围栏提取，
 * 是消息的派生渲染模型——不进协议、不落快照，消息删除时随之消失。
 * title 取自 HTML 内的 <title> 标签（可选）。
 */
export interface ZWidgetMessageBlock {
  kind: typeof ZWIDGET_BLOCK_KIND;
  html: string;
  title?: string;
}

/** iframe sandbox 属性值：只放开脚本（组件交互自闭环），绝不含 allow-same-origin。 */
export const ZWIDGET_IFRAME_SANDBOX = "allow-scripts";

/** widget iframe 的 referrer 策略：不泄漏来源。 */
export const ZWIDGET_IFRAME_REFERRER_POLICY = "no-referrer";

/**
 * widget 文档的 CSP：default-src 'none' 关死一切外部加载，只放开内联
 * script/style 与 data:/blob: 的自包含资源。connect-src 'none' 确保无网络
 * fetch；后续若放开网络必须走显式审批（spec 非目标）。
 */
export const ZWIDGET_IFRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
].join("; ");

// ── 围栏提取 ──────────────────────────────────────────────────

const ZWIDGET_FENCE_RE = /^```zwidget[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
const ZWIDGET_TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

function decodeHtmlTextEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 读取 widget HTML 里的 <title>（截断到 80 字符，实体解码，供卡片标题展示）。 */
export function readZWidgetHtmlTitle(html: string): string | undefined {
  const match = ZWIDGET_TITLE_RE.exec(html);
  if (!match?.[1]) return undefined;
  const title = decodeHtmlTextEntities(match[1]).replace(/\s+/g, " ").trim();
  if (!title) return undefined;
  return title.length > 80 ? `${title.slice(0, 80)}…` : title;
}

/**
 * 从 assistant 回复 markdown 中提取全部闭合的 ```zwidget 围栏块。
 * 只认闭合围栏：流式输出中的未闭合围栏由上层在完成态再提取（与 mermaid 渲染
 * 同款的"完成后渲染"节奏），流式期间不会渲染半个 widget。
 */
export function extractZWidgetBlocks(markdown: string): ZWidgetMessageBlock[] {
  const blocks: ZWidgetMessageBlock[] = [];
  ZWIDGET_FENCE_RE.lastIndex = 0;
  for (const match of markdown.matchAll(ZWIDGET_FENCE_RE)) {
    const html = match[1] ?? "";
    if (!html.trim()) continue;
    const block: ZWidgetMessageBlock = { kind: ZWIDGET_BLOCK_KIND, html };
    const title = readZWidgetHtmlTitle(html);
    if (title) block.title = title;
    blocks.push(block);
  }
  return blocks;
}

// ── 大小预算 ──────────────────────────────────────────────────

export function getZWidgetHtmlByteLength(html: string): number {
  // TextEncoder 在浏览器与 Node ≥ 11 均为全局；shared 模块两侧共用。
  return new TextEncoder().encode(html).length;
}

export function isZWidgetHtmlWithinSizeLimit(html: string): boolean {
  return getZWidgetHtmlByteLength(html) <= ZWIDGET_HTML_MAX_BYTES;
}

// ── 静态安全扫描（渲染前的第二层防线；第一层是 sandbox + CSP） ──

export type ZWidgetSecurityScan =
  | { ok: true }
  | { ok: false; rule: ZWidgetSecurityRule; message: string };

export type ZWidgetSecurityRule = "node-bridge" | "parent-access" | "external-resource";

interface ZWidgetSecurityRuleSpec {
  rule: ZWidgetSecurityRule;
  pattern: RegExp;
  message: string;
}

/**
 * 静态拒绝规则（specs/deliverable-cards.md 安全模型）：
 * sandbox iframe 本身已保证 node/electron 不可达、父窗口跨源访问抛错、CSP 拦网络；
 * 静态扫描是纵深防御的第二层——命中即拒绝渲染，让"必须失败"在进入 iframe 之前
 * 就发生，便于日志观测（验收场景 3）。
 */
export const ZWIDGET_SECURITY_RULES: readonly ZWidgetSecurityRuleSpec[] = [
  {
    rule: "node-bridge",
    pattern:
      /\b(?:require\s*\(|nodeRequire|process\s*\.\s*(?:versions|binding|mainModule|env)|__dirname|__filename|module\s*\.\s*exports|globalBuffer)/,
    message: "widget 不允许引用 Node/Electron 桥（require、process.* 等）",
  },
  {
    rule: "node-bridge",
    pattern: /\belectron\b/i,
    message: "widget 不允许引用 electron",
  },
  {
    rule: "parent-access",
    pattern:
      /\b(?:window\s*\.\s*(?:parent|top)|parent\s*\.\s*(?:document|window|location|postMessage)|top\s*\.\s*(?:document|window|location)|frameElement)\b/,
    message: "widget 不允许访问父窗口/顶层窗口 DOM",
  },
  {
    rule: "external-resource",
    pattern: /(?:\bsrc|\bhref)\s*=\s*["']?\s*(?:https?:)?\/\//i,
    message: "widget 必须自包含，不允许外部资源引用",
  },
  {
    rule: "external-resource",
    pattern: /\b(?:fetch|XMLHttpRequest|EventSource|WebSocket|importScripts)\s*\(/,
    message: "widget 不允许发起网络请求",
  },
];

/** 渲染前静态扫描：命中任一规则即返回失败（首个命中优先）。 */
export function scanZWidgetHtml(html: string): ZWidgetSecurityScan {
  for (const spec of ZWIDGET_SECURITY_RULES) {
    if (spec.pattern.test(html)) {
      return { ok: false, rule: spec.rule, message: spec.message };
    }
  }
  return { ok: true };
}

// ── sandbox 文档组装 ───────────────────────────────────────────

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 属性值上下文只需转义 & 与 "：CSP 里的 'unsafe-inline' 单引号保留原样，
 * 实体编码会让"meta 属性里能 grep 到原始 CSP 指令"这一测试/审计约定失效。
 */
function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

const ZWIDGET_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(
  ZWIDGET_IFRAME_CSP,
)}">`;

/**
 * 把 widget HTML 组装成可直接进 iframe srcDoc 的完整文档，强制带上 CSP meta：
 * - 已有 <head>：CSP meta 插到 head 开头（先于任何内联 script 执行）。
 * - 片段 HTML：包一层最小文档。
 * 该函数不负责安全扫描与大小检查，调用方必须先过 scanZWidgetHtml 与大小预算。
 */
export function buildZWidgetSandboxDocument(html: string, options?: { title?: string }): string {
  const titleTag = options?.title
    ? `<title>${escapeHtmlText(options.title)}</title>`
    : "<title>zwidget</title>";

  const headWithCsp = `${titleTag}${ZWIDGET_CSP_META}`;

  if (/<html[\s>]/i.test(html)) {
    const headMatch = /<head[^>]*>/i.exec(html);
    if (headMatch) {
      return `${html.slice(0, headMatch.index + headMatch[0].length)}${headWithCsp}${html.slice(
        headMatch.index + headMatch[0].length,
      )}`;
    }
    const htmlOpenMatch = /<html[^>]*>/i.exec(html);
    if (htmlOpenMatch) {
      return `${html.slice(0, htmlOpenMatch.index + htmlOpenMatch[0].length)}<head>${headWithCsp}</head>${html.slice(
        htmlOpenMatch.index + htmlOpenMatch[0].length,
      )}`;
    }
  }

  return `<!doctype html><html><head>${headWithCsp}</head><body>${html}</body></html>`;
}
