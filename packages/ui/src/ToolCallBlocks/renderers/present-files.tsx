/**
 * PresentFiles 工具卡 —— 交付物卡片（specs/deliverable-cards.md）。
 *
 * 模型调用 present_files 声明交付物后，本 renderer 把路径渲染为消息流内可点击
 * 卡片：点击走现有 media-preview 打开路径（onOpenCodeViewer，与 OpenSplitButton
 * 的预览入口同一条链路）。首个文件自动打开仅在有预览面板的桌面形态生效——
 * 以 platform 是否实现桌面专属能力 createLocalMediaPreviewUrl 判定（web/手机
 * 远控形态不实现该能力）。
 * 卡片是工具调用的派生渲染，不新建持久化状态；自动打开按 toolCallId 一次性
 * 消费（模块级记录，模式同 ToolCallBlocks 的 toolEntranceAnimationKeys）。
 */
import { PackageIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { IPlatformService } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import {
  buildPresentFilesCards,
  buildPresentFilesCardPreviewSource,
  readPresentFilesDeclaration,
  type PresentFilesCard,
} from "@/lib/presentFilesCards.js";
import { logger } from "@/logger.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const PRESENT_FILES_TOOL_ICON = <PackageIcon className="size-4 shrink-0 text-foreground-subtle" />;

/** 已消费过自动打开的 toolCallId；窗口生命周期内不重复打开（含虚拟列表重挂载）。 */
const consumedAutoOpenToolCallIds = new Set<string>();

export function isPresentFilesToolCall(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): boolean {
  // 按固定工具名认领（workflowToolNames 同款先例）：present_files 不在 shared
  // 已知工具表里，identity 回 unknown；名字是 contracts/shared 两侧共同的单一事实源。
  return (
    toolCall.toolName?.trim().toLowerCase() === "present_files" ||
    toolCall.kind?.trim().toLowerCase() === "present_files"
  );
}

/** 桌面形态判定：只有桌面 platform 实现桌面专属的本地媒体预览能力。 */
export function isDesktopLikePlatform(
  platform: Pick<IPlatformService, "createLocalMediaPreviewUrl"> | null,
): boolean {
  return typeof platform?.createLocalMediaPreviewUrl === "function";
}

function PresentFilesCardRow({
  card,
  note,
  onOpen,
}: {
  card: PresentFilesCard;
  note?: string;
  onOpen?: () => void;
}) {
  const descriptor = resolveFileDisplayDescriptor(card.path);
  const subtitle = note ?? card.path;
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-xl border border-card-border bg-card p-3 pr-4 text-left transition-colors hover:bg-card-selected disabled:cursor-default disabled:hover:bg-card"
      data-zcode-present-file={card.path}
      data-testid="present-files-card"
      disabled={!onOpen}
      onClick={onOpen}
    >
      <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-background text-foreground-subtle">
        <FileDisplayIcon src={descriptor.fileIconSrc} size={24} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-ui-base font-medium leading-5 text-foreground">
          {card.fileName}
        </span>
        <span className="truncate text-ui-base leading-5 text-foreground-subtlest">{subtitle}</span>
      </span>
    </button>
  );
}

export function PresentFilesToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const { toolCall } = context.toolCallNode;
  const declaration = readPresentFilesDeclaration(toolCall);
  const cards = useMemo(
    () => (declaration ? buildPresentFilesCards(declaration) : []),
    [declaration],
  );

  const autoOpenFiredRef = useRef(false);
  const firstCard = cards[0];
  const canAutoOpen =
    Boolean(firstCard) &&
    declaration?.completed === true &&
    isDesktopLikePlatform(platform) &&
    typeof context.onOpenCodeViewer === "function";

  // 首卡自动打开（spec：仅桌面形态）。一次性语义：按 toolId 消费，虚拟列表重挂载、
  // 历史消息恢复都不重放；onOpenCodeViewer 不可用（只读时间线）时静默跳过。
  useEffect(() => {
    if (!canAutoOpen || !firstCard || autoOpenFiredRef.current) return;
    if (consumedAutoOpenToolCallIds.has(toolCall.toolId)) {
      autoOpenFiredRef.current = true;
      return;
    }
    autoOpenFiredRef.current = true;
    consumedAutoOpenToolCallIds.add(toolCall.toolId);
    logger.info("present_files auto-open first deliverable", {
      toolCallId: toolCall.toolId,
      path: firstCard.path,
    });
    context.onOpenCodeViewer?.(
      buildPresentFilesCardPreviewSource(firstCard, context.workspacePath),
    );
  }, [canAutoOpen, context, firstCard, toolCall.toolId]);

  if (!declaration) {
    // 名字命中但路径尚未解析出来（流式早期/异常入参）：给一张最小挂起卡，
    // 不退回 raw JSON 兜底（那会把模型入参 JSON 摊进聊天区）。
    return (
      <ToolLayout
        icon={PRESENT_FILES_TOOL_ICON}
        kindLabel={intl.formatMessage({ id: "chat.presentFiles.kind" })}
        primaryText={intl.formatMessage({ id: "chat.presentFiles.pending" })}
        secondaryText={context.statusLabel}
        showIcon={context.showIcon}
        toolId={toolCall.toolId}
      />
    );
  }

  const handleOpenCard = (card: PresentFilesCard) => () => {
    context.onOpenCodeViewer?.(buildPresentFilesCardPreviewSource(card, context.workspacePath));
  };

  const renderCards = useCallback(
    () => (
      <div className="flex w-full flex-col gap-3">
        {cards.map((card) => (
          <PresentFilesCardRow
            key={card.id}
            card={card}
            note={declaration.note}
            onOpen={context.onOpenCodeViewer ? handleOpenCard(card) : undefined}
          />
        ))}
      </div>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- context.onOpenCodeViewer 是 render context 上的稳定回调；cards/declaration 已覆盖数据变化。
    [cards, declaration.note, context.onOpenCodeViewer],
  );

  const primaryText =
    declaration.note?.trim() ||
    intl.formatMessage({ id: "chat.presentFiles.summary" }, { count: cards.length });

  return (
    <ToolLayout
      autoCollapseOnComplete
      canToggle={false}
      forceOpen
      icon={PRESENT_FILES_TOOL_ICON}
      kindLabel={intl.formatMessage({ id: "chat.presentFiles.kind" })}
      primaryText={primaryText}
      renderContent={renderCards}
      secondaryText={context.statusLabel}
      showIcon={context.showIcon}
      toolId={toolCall.toolId}
    />
  );
}
