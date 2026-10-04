/**
 * Pdf Locate 工具卡 —— PDF 预览联动（specs/pdf-preview-linkage.md）。
 *
 * pdf_locate 不新增协议事件：本 renderer 按名认领工具调用（present_files 同款先例），
 * 从 input/output（模型回显文本）读出定位请求；完成时一次性触发预览联动——发布到
 * pdfLocateStore 并经 onOpenCodeViewer（既有 media-preview 打开路径）打开/切换预览
 * 面板。卡片是工具调用的派生渲染，不新建持久化状态；自动定位按 toolCallId 一次性
 * 消费（模块级记录，虚拟列表重挂载/历史恢复不重放）。桌面形态判定与 present_files
 * 同款（platform 实现桌面专属 createLocalMediaPreviewUrl）；onOpenCodeViewer 不可用
 * （只读时间线）时静默跳过自动定位，卡片仍可点击手动打开。
 */
import { FileSearchIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { isDesktopLikePlatform } from "@/ToolCallBlocks/renderers/present-files.js";
import { readPdfLocateRequest, type PdfLocateRequest } from "@/lib/pdfLocateRequest.js";
import { usePdfLocateStore } from "@/store/pdfLocateStore.js";
import { logger } from "@/logger.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const PDF_LOCATE_TOOL_ICON = <FileSearchIcon className="size-4 shrink-0 text-foreground-subtle" />;

/** 已消费过自动定位的 toolCallId；窗口生命周期内不重复定位（含虚拟列表重挂载）。 */
const consumedAutoLocateToolCallIds = new Set<string>();

export function isPdfLocateToolCall(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): boolean {
  return (
    toolCall.toolName?.trim().toLowerCase() === "pdf_locate" ||
    toolCall.kind?.trim().toLowerCase() === "pdf_locate"
  );
}

/** 卡片与自动定位共用的打开动作：发布定位请求 + 走既有预览打开路径切到该 PDF。 */
function locateAndOpenPdf(request: PdfLocateRequest, context: ToolCallBlockRenderContext): void {
  // 先发布后打开：预览面板在 onOpenCodeViewer 切到目标文件后按路径匹配消费 pending。
  usePdfLocateStore.getState().publish(request);
  context.onOpenCodeViewer?.({
    type: "file",
    title: request.fileName,
    path: request.filePath,
    ...(context.workspacePath ? { workspacePath: context.workspacePath } : {}),
  });
  logger.info("pdf_locate triggered preview locate", {
    page: request.page,
    path: request.filePath,
    status: request.status ?? "unknown",
  });
}

function resolveSummaryMessageId(request: PdfLocateRequest): string {
  if (request.status === "located") return "chat.pdfLocate.locatedSummary";
  if (request.status === "page_only") return "chat.pdfLocate.pageOnlySummary";
  if (request.status === "file_opened") return "chat.pdfLocate.openedSummary";
  return "chat.pdfLocate.fallbackSummary";
}

export function PdfLocateToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const { toolCall } = context.toolCallNode;
  const request = useMemo(() => readPdfLocateRequest(toolCall), [toolCall]);

  const autoLocateFiredRef = useRef(false);
  const canAutoLocate =
    Boolean(request) &&
    toolCall.status === "completed" &&
    isDesktopLikePlatform(platform) &&
    typeof context.onOpenCodeViewer === "function";

  // 自动定位（一次性语义，present_files 自动打开同款）。pending 卡（回显未到）不触发。
  useEffect(() => {
    if (!canAutoLocate || !request || autoLocateFiredRef.current) return;
    if (consumedAutoLocateToolCallIds.has(toolCall.toolId)) {
      autoLocateFiredRef.current = true;
      return;
    }
    autoLocateFiredRef.current = true;
    consumedAutoLocateToolCallIds.add(toolCall.toolId);
    locateAndOpenPdf(request, context);
  }, [canAutoLocate, context, request, toolCall.toolId]);

  if (!request) {
    // 名字命中但定位请求尚未可读（流式早期/回显未到）：最小挂起卡，不退回 raw JSON。
    return (
      <ToolLayout
        icon={PDF_LOCATE_TOOL_ICON}
        kindLabel={intl.formatMessage({ id: "chat.pdfLocate.kind" })}
        primaryText={intl.formatMessage({ id: "chat.pdfLocate.pending" })}
        secondaryText={context.statusLabel}
        showIcon={context.showIcon}
        toolId={toolCall.toolId}
      />
    );
  }

  const handleLocate = () => {
    locateAndOpenPdf(request, context);
  };

  const renderContent = () =>
    context.onOpenCodeViewer ? (
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-card-border bg-card px-3 py-2 text-left transition-colors hover:bg-card-selected"
        data-testid="pdf-locate-card"
        onClick={handleLocate}
      >
        <span className="truncate text-ui-base text-foreground">{request.fileName}</span>
        <span className="shrink-0 text-ui-base text-foreground-subtlest">
          {intl.formatMessage({ id: "chat.pdfLocate.openPreview" })}
        </span>
      </button>
    ) : null;

  return (
    <ToolLayout
      autoCollapseOnComplete
      canToggle={false}
      forceOpen
      icon={PDF_LOCATE_TOOL_ICON}
      kindLabel={intl.formatMessage({ id: "chat.pdfLocate.kind" })}
      primaryText={intl.formatMessage(
        { id: resolveSummaryMessageId(request) },
        { page: request.page },
      )}
      renderContent={renderContent}
      secondaryText={context.statusLabel}
      showIcon={context.showIcon}
      toolId={toolCall.toolId}
    />
  );
}
