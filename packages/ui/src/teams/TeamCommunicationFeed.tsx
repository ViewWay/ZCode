// 团队协作面板·通讯面板(v2.10):全队消息流,按类型筛选,按时间倒序。
// 筛选:report=任务通知 assign=text 指派 system=空闲/关机类;未读以蓝点标记。
// 只读展示,不修改任何事实源。

import { useState } from "react";
import type { TeamInboxMessageProjection } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type FeedFilter = "all" | "report" | "assign" | "system";

const FILTERS: { id: FeedFilter; labelId: string }[] = [
  { id: "all", labelId: "chat.teams.feed.filterAll" },
  { id: "report", labelId: "chat.teams.feed.filterReport" },
  { id: "assign", labelId: "chat.teams.feed.filterAssign" },
  { id: "system", labelId: "chat.teams.feed.filterSystem" },
];

function matchesFilter(message: TeamInboxMessageProjection, filter: FeedFilter): boolean {
  if (filter === "all") return true;
  if (filter === "report") return message.payloadKind === "task_notification";
  if (filter === "assign") return message.payloadKind === "text";
  return ["idle_notification", "shutdown_request", "shutdown_response"].includes(message.payloadKind);
}

/** "9:05" 风格短时间;非法时间戳兜底为空串。 */
function formatTime(sentAt: string): string {
  const date = new Date(sentAt);
  if (Number.isNaN(date.getTime())) return "";
  const pad2 = (value: number) => String(value).padStart(2, "0");
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function TeamCommunicationFeed({ messages }: { messages: TeamInboxMessageProjection[] }) {
  const { intl } = useZCodeIntl();
  const [filter, setFilter] = useState<FeedFilter>("all");
  const sorted = [...messages].sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  const visible = sorted.filter((message) => matchesFilter(message, filter));

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setFilter(option.id)}
            className={cn(
              "rounded px-1.5 py-0.5 text-ui-xs",
              filter === option.id
                ? "bg-accent font-medium text-foreground"
                : "text-foreground-subtle hover:bg-accent",
            )}
          >
            {intl.formatMessage({ id: option.labelId })}
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className="px-1 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "chat.teams.inbox.empty" })}
        </p>
      ) : (
        <ul className="space-y-1">
          {visible.map((message) => (
            <li key={message.id} className="min-w-0 rounded-md border border-border px-2 py-1.5">
              <div className="flex min-w-0 items-center gap-1.5">
                {!message.read ? (
                  <span aria-hidden className="size-1 shrink-0 rounded-full bg-blue-500" />
                ) : null}
                <span className="min-w-0 truncate text-ui-xs text-foreground-subtle">
                  {message.from} → {message.to} · {message.payloadKind}
                </span>
                <span className="ml-auto shrink-0 text-ui-xs text-foreground-subtle">
                  {formatTime(message.sentAt)}
                </span>
              </div>
              {message.text !== undefined || message.summary !== undefined ? (
                <p className="mt-0.5 min-w-0 whitespace-pre-wrap break-words text-ui-xs text-foreground">
                  {(message.text ?? message.summary ?? "").slice(0, 500)}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
