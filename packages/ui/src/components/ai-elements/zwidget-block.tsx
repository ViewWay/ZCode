/**
 * ZWidgetBlock —— 消息流内嵌交互组件的沙箱容器（specs/deliverable-cards.md）。
 *
 * 模型回复中的 ```zwidget 围栏块由 MessageResponse 的 code renderer 分流到本组件：
 * - 渲染前两道闸：静态安全扫描（require/electron/父窗口/外部资源 → 拒绝渲染）与
 *   2MB 大小预算（超限降级为提示）；
 * - 通过后进 sandbox iframe：sandbox="allow-scripts"（无 allow-same-origin，父窗口
 *   与子文档跨源，window.parent 访问即抛错），srcDoc 文档由 shared 的
 *   buildZWidgetSandboxDocument 组装，CSP 关死一切网络；
 * - 设置开关 messageStreamZwidgetEnabled（默认开启；undefined 即开）；
 * - 组件内部交互自闭环，无任何到宿主的运行时桥接（spec 非目标：禁用双向数据交互）。
 * 生命周期随消息：本组件不新建持久化状态，消息卸载即销毁。
 */
"use client";

import { AlertTriangleIcon, MousePointerClickIcon } from "lucide-react";
import { useEffect, useState, type HTMLAttributes } from "react";
import {
  buildZWidgetSandboxDocument,
  getZWidgetHtmlByteLength,
  isZWidgetHtmlWithinSizeLimit,
  scanZWidgetHtml,
  ZWIDGET_FENCE_LANGUAGE,
  ZWIDGET_HTML_MAX_BYTES,
  ZWIDGET_IFRAME_REFERRER_POLICY,
  ZWIDGET_IFRAME_SANDBOX,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

/** 沙箱 iframe 的固定展示高度：交互演示以横向为主，过高会淹没消息流。 */
const ZWIDGET_IFRAME_HEIGHT_PX = 320;

export interface ZWidgetBlockProps extends HTMLAttributes<HTMLDivElement> {
  /** ```zwidget 围栏的原始内容（HTML，可带 <title>）。 */
  code: string;
  /** 是否启用 zwidget 渲染（设置开关）；缺省走 useZWidgetSettingEnabled。 */
  enabled?: boolean;
}

/** 拒绝渲染的原因形态（安全扫描命中 / 超大小预算）。 */
interface ZWidgetRejection {
  kind: "security" | "oversize" | "disabled";
  message: string;
}

/**
 * 读取 zwidget 渲染开关。设置服务不可用（只读分享时间线等）时保持默认开启，
 * 不因宿主能力缺席而吞掉消息内容。
 */
function useZWidgetSettingEnabled(): boolean {
  const services = useOptionalServices();
  const platform = useOptionalPlatform();
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    let disposed = false;
    const settingService = services?.settingService;
    if (!settingService) return;
    void settingService
      .get()
      .then((settings) => {
        if (disposed) return;
        // undefined 即默认开启（specs/deliverable-cards.md 开关策略）。
        setEnabled(settings.messageStreamZwidgetEnabled !== false);
      })
      .catch(() => {
        // 读取失败保持默认开启，不阻塞渲染。
      });
    return platform?.onSettingsChanged?.(() => {
      void settingService
        .get()
        .then((next) => {
          if (!disposed) setEnabled(next.messageStreamZwidgetEnabled !== false);
        })
        .catch(() => undefined);
    });
  }, [platform, services]);

  return enabled;
}

/**
 * 评估一段 widget HTML 是否可渲染。纯判定集中在这里，组件与测试共用同一语义。
 * 流式期间的"完成后渲染"节奏由 MessageResponse 的 code renderer 守卫，不进本判定。
 */
export function evaluateZWidgetHtml(
  html: string,
  options: { enabled: boolean },
): ZWidgetRejection | null {
  if (!options.enabled) {
    return { kind: "disabled", message: "zwidget rendering is disabled in settings" };
  }
  if (!isZWidgetHtmlWithinSizeLimit(html)) {
    return {
      kind: "oversize",
      message: `widget exceeds ${ZWIDGET_HTML_MAX_BYTES} bytes (${getZWidgetHtmlByteLength(html)})`,
    };
  }
  const scan = scanZWidgetHtml(html);
  if (!scan.ok) {
    return { kind: "security", message: `[${scan.rule}] ${scan.message}` };
  }
  return null;
}

export function ZWidgetBlock({ code, enabled, ...props }: ZWidgetBlockProps) {
  const { intl } = useZCodeIntl();
  const settingEnabled = useZWidgetSettingEnabled();
  const widgetEnabled = enabled ?? settingEnabled;

  const rejection = evaluateZWidgetHtml(code, { enabled: widgetEnabled });

  useEffect(() => {
    // 安全用例要求"失败并被记录"（验收场景 3）：静态命中在这里落 warn 日志，
    // 供生产观测；sandbox/CSP 运行时拦截另有浏览器控制台记录。
    if (rejection?.kind === "security" || rejection?.kind === "oversize") {
      logger.warn("zwidget render rejected", { reason: rejection.kind, detail: rejection.message });
    }
  }, [rejection?.kind, rejection?.message]);

  if (rejection) {
    const messageId =
      rejection.kind === "security"
        ? "chat.zwidget.blocked"
        : rejection.kind === "oversize"
          ? "chat.zwidget.oversize"
          : "chat.zwidget.disabled";
    return (
      <div
        className="my-4 flex items-center gap-2 rounded-xl border border-card-border bg-card px-4 py-3 text-ui-sm text-foreground-subtle"
        data-zcode-zwidget="rejected"
        data-zcode-zwidget-reason={rejection.kind}
        {...props}
      >
        <AlertTriangleIcon className="size-4 shrink-0 text-foreground-subtle" />
        <span>{intl.formatMessage({ id: messageId })}</span>
      </div>
    );
  }

  const sandboxDocument = buildZWidgetSandboxDocument(code);
  return (
    <div className="my-4 overflow-hidden rounded-xl border border-card-border bg-card" {...props}>
      <div className="flex items-center gap-2 border-b border-card-border px-4 py-2 text-ui-sm text-foreground-subtle">
        <MousePointerClickIcon className="size-4 shrink-0" />
        <span>{intl.formatMessage({ id: "chat.zwidget.title" })}</span>
        <span className="ml-auto font-mono text-ui-xs text-foreground-subtlest">
          {ZWIDGET_FENCE_LANGUAGE}
        </span>
      </div>
      <iframe
        className="block w-full border-0 bg-background"
        data-zcode-zwidget="frame"
        height={ZWIDGET_IFRAME_HEIGHT_PX}
        loading="lazy"
        referrerPolicy={ZWIDGET_IFRAME_REFERRER_POLICY}
        sandbox={ZWIDGET_IFRAME_SANDBOX}
        srcDoc={sandboxDocument}
        title={intl.formatMessage({ id: "chat.zwidget.title" })}
      />
    </div>
  );
}
