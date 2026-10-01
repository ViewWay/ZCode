// 团队协作面板·状态栏(v2.10):阶段推断 + 四类任务计数 + 团队名。
// 阶段由任务状态推断:全部 completed = 已完成;存在 in_progress = 执行中;其余 = 待领。
// 只读展示,不修改任何事实源。

import type { TeamTaskProjection } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 非终态且存在未 completed 的前驱 = 阻塞判定(依赖未全满足,不可认领)。 */
function isBlocked(task: TeamTaskProjection, completedIds: Set<string>): boolean {
  if (task.status === "completed" || task.status === "cancelled") return false;
  return (task.blockedBy ?? []).some((id) => !completedIds.has(id));
}

export function TeamStatusBar({ tasks, teamName }: { tasks: TeamTaskProjection[]; teamName?: string }) {
  const { intl } = useZCodeIntl();
  const completedIds = new Set(
    tasks.filter((task) => task.status === "completed").map((task) => task.taskId),
  );
  const done = tasks.filter((task) => task.status === "completed").length;
  const inProgress = tasks.filter((task) => task.status === "in_progress").length;
  const pending = tasks.filter((task) => task.status === "pending").length;
  const blocked = tasks.filter((task) => isBlocked(task, completedIds)).length;

  // 阶段:全部 completed → 已完成;存在 in_progress → 执行中;其余 → 待领。无任务不展示。
  const phaseKey =
    tasks.length === 0
      ? undefined
      : done === tasks.length
        ? "chat.teams.dashboard.done"
        : inProgress > 0
          ? "chat.teams.dashboard.inProgress"
          : "chat.teams.dashboard.pending";

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border px-2 py-1.5">
      {phaseKey ? (
        <span className="rounded bg-accent px-1.5 py-0.5 text-ui-xs font-medium text-foreground">
          {intl.formatMessage({ id: "chat.teams.dashboard.phase" })} · {intl.formatMessage({ id: phaseKey })}
        </span>
      ) : null}
      <span className="text-ui-xs text-foreground-subtle">✓ {done}</span>
      <span className="text-ui-xs text-foreground-subtle">⏳ {inProgress}</span>
      <span className="text-ui-xs text-foreground-subtle">⏸ {pending}</span>
      <span className={cn("text-ui-xs text-foreground-subtle", blocked > 0 && "text-amber-600")}>
        🔒 {blocked}
      </span>
      {teamName ? <span className="ml-auto truncate text-ui-xs text-foreground-subtle">{teamName}</span> : null}
    </div>
  );
}
