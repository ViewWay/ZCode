/**
 * 草稿首页模式标签页（对话 | 任务），对齐 ChatGPT 的 ChatGPT ↔ Codex 切换形态。
 * 见 specs/chatgpt-mode-tabs.md；两种模式共用同一 composer 与推荐 chips 实例，
 * 切换只替换问候语与占位文案，不重挂载输入区。
 */
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ChatHomeMode } from "@/lib/chatPlaceholder.js";

const MODE_TABS = [
  { id: "chat", labelId: "chat.draft.mode.chat" },
  { id: "tasks", labelId: "chat.draft.mode.tasks" },
] as const;

export function ConversationDraftModeTabs({
  mode,
  onModeChange,
  className,
}: {
  mode: ChatHomeMode;
  onModeChange: (mode: ChatHomeMode) => void;
  className?: string;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div
      role="tablist"
      aria-label={intl.formatMessage({ id: "chat.draft.mode.label" })}
      className={cn("mb-6 flex justify-center", className)}
    >
      <div className="inline-flex items-center gap-0.5 rounded-full bg-secondary p-1">
        {MODE_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={mode === tab.id}
            data-testid={`v4-draft-mode-${tab.id}`}
            onClick={() => onModeChange(tab.id)}
            className={cn(
              "inline-flex h-7 items-center rounded-full px-3.5 text-ui-caption font-medium transition-colors",
              mode === tab.id
                ? "bg-card text-foreground shadow-sm"
                : "text-foreground-subtle hover:text-foreground",
            )}
          >
            {intl.formatMessage({ id: tab.labelId })}
          </button>
        ))}
      </div>
    </div>
  );
}
