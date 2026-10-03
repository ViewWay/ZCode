import type { ChatViewSummaryPanelVariant } from "@/v4/legacyChatViewTypes.js";

// ChatGPT 风格化（specs/chatgpt-style-chat-surface.md）：草稿列与会话列统一 48rem
// （max-w-3xl）居中窄列；会话态的让位 calc 语义保留，仅收敛宽度上限。
const CONVERSATION_DRAFT_CONTENT_WIDTH_CLASS_NAME = "max-w-3xl";
// 有/无 inline 状态面板的宽度规则在统一 48rem 列后合并为同一组类；
// 面板让位由 getConversationStatusPanelOffsetClassName 单独下发。
const CONVERSATION_CONTENT_WIDTH_CLASS_NAME =
  "w-full @min-[864px]/conversation:w-[calc(100%_-_6rem)] @min-[864px]/conversation:max-w-3xl @min-[1280px]/conversation:w-[calc(100%_-_24rem)] @min-[1280px]/conversation:max-w-3xl";
const CONVERSATION_STATUS_PANEL_WIDE_OFFSET_CLASS_NAME =
  "@min-[1280px]/conversation:-translate-x-42";

type ConversationStatusPanelResolvedVariant = ChatViewSummaryPanelVariant | "auto";

export function getConversationContentWidthClassName(params: {
  centeredEmptyLayout: boolean;
}): string {
  return params.centeredEmptyLayout
    ? CONVERSATION_DRAFT_CONTENT_WIDTH_CLASS_NAME
    : CONVERSATION_CONTENT_WIDTH_CLASS_NAME;
}

export function resolveConversationStatusPanelVariant(params: {
  variantOverride: ConversationStatusPanelResolvedVariant | null;
}): ConversationStatusPanelResolvedVariant {
  // 自动模式必须保留到 DOM，由 conversation container query 裁决实际形态；
  // React 不再通过 ResizeObserver 把容器宽度翻译成业务状态。
  return params.variantOverride ?? "auto";
}

export function shouldUseConversationStatusPanelInlineLayout(params: {
  hasContent: boolean;
  variant: ConversationStatusPanelResolvedVariant;
}): boolean {
  return params.hasContent && params.variant !== "mini";
}

export function getConversationStatusPanelOffsetClassName(
  layout: "none" | "auto" | "inline",
): string | undefined {
  // 状态面板和会话宽布局统一在 1280px 启用，保证面板状态切换不改变响应分水岭。
  return layout === "none" ? undefined : CONVERSATION_STATUS_PANEL_WIDE_OFFSET_CLASS_NAME;
}
