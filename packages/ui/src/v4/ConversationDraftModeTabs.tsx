/**
 * 草稿首页模式标签页（对话 | 任务），对齐 ChatGPT 的 ChatGPT ↔ Codex 切换形态。
 * 见 specs/chatgpt-mode-tabs.md；两种模式共用同一 composer 与推荐 chips 实例，
 * 切换只替换问候语与占位文案，不重挂载输入区。
 * 键盘模式对齐 AutomationsPageTitleSwitch 先例：方向键循环 + roving tabindex。
 */
import { useCallback, type KeyboardEvent } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ChatHomeMode } from "@/lib/chatPlaceholder.js";

const MODE_TABS = [
  { id: "chat", labelId: "chat.draft.mode.chat" },
  { id: "tasks", labelId: "chat.draft.mode.tasks" },
] as const;

const DRAFT_HOME_TABPANEL_ID = "v4-draft-home-tabpanel";

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

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const index = MODE_TABS.findIndex((tab) => tab.id === mode);
      const offset = event.key === "ArrowRight" ? 1 : -1;
      const next = MODE_TABS[(index + offset + MODE_TABS.length) % MODE_TABS.length]!.id;
      onModeChange(next);
    },
    [mode, onModeChange],
  );

  return (
    <div
      role="tablist"
      aria-label={intl.formatMessage({ id: "chat.draft.mode.label" })}
      onKeyDown={handleKeyDown}
      className={cn("mb-6 flex justify-center", className)}
    >
      <div className="inline-flex items-center gap-0.5 rounded-full bg-secondary p-1">
        {MODE_TABS.map((tab) => {
          const active = mode === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={DRAFT_HOME_TABPANEL_ID}
              tabIndex={active ? 0 : -1}
              id={`v4-draft-mode-tab-${tab.id}`}
              data-testid={`v4-draft-mode-${tab.id}`}
              onClick={() => onModeChange(tab.id)}
              className={cn(
                "inline-flex h-7 items-center rounded-full px-3.5 text-ui-caption font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
                active
                  ? "bg-card text-foreground shadow-sm"
                  : "text-foreground-subtle hover:text-foreground",
              )}
            >
              {intl.formatMessage({ id: tab.labelId })}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export { DRAFT_HOME_TABPANEL_ID };
