// 团队协作面板·计划审批(v2.10):plan.json 只读投影,供用户审阅团队草案。
// 状态机 draft → review_pending → approved(cancelled 终态),state 原样展示;
// 批准/驳回动作在 runtime TeamPlanApprove 工具的权限确认窗执行,本面板纯展示,
// 不含任何写路径或审批按钮。

import type { TeamPlanProjection } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** prompt 预览截断长度:prompt 仅作辨识,不在此读全文。 */
const PROMPT_PREVIEW_LIMIT = 120;

export function TeamPlanPanel({ plan, teamName }: { plan: TeamPlanProjection; teamName: string }) {
  const { intl } = useZCodeIntl();

  return (
    <div className="min-w-0 space-y-1.5 rounded-md border border-border px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-ui-xs font-medium text-foreground">
          {intl.formatMessage({ id: "chat.teams.plan.state" })}
        </span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-ui-xs",
            plan.state === "review_pending"
              ? "bg-amber-500/15 font-medium text-amber-600"
              : "bg-accent text-foreground",
          )}
        >
          {plan.state}
        </span>
        <span className="ml-auto truncate text-ui-xs text-foreground-subtle">{teamName}</span>
      </div>

      <div>
        <p className="text-ui-xs font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "chat.teams.plan.members" })}
        </p>
        <ul className="mt-1 space-y-1">
          {plan.members.map((member) => (
            <li key={member.name} className="min-w-0 rounded-md border border-border px-2 py-1">
              <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <span className="min-w-0 truncate text-ui-xs font-medium text-foreground">{member.name}</span>
                {member.difficulty ? (
                  <span className="shrink-0 rounded bg-accent px-1 py-0.5 text-ui-xs text-foreground-subtle">
                    {member.difficulty}
                  </span>
                ) : null}
                {member.reason ? (
                  <span className="min-w-0 truncate text-ui-xs text-foreground-subtle">{member.reason}</span>
                ) : null}
              </div>
              {member.prompt ? (
                <p className="mt-0.5 whitespace-pre-wrap break-words text-ui-xs text-foreground-subtle">
                  {member.prompt.slice(0, PROMPT_PREVIEW_LIMIT)}
                  {member.prompt.length > PROMPT_PREVIEW_LIMIT ? "…" : ""}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="text-ui-xs font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "chat.teams.plan.tasks" })}
        </p>
        <ul className="mt-1 space-y-1">
          {plan.tasks.map((task) => (
            <li key={task.subject} className="min-w-0 rounded-md border border-border px-2 py-1">
              <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <span className="min-w-0 truncate text-ui-xs text-foreground">{task.subject}</span>
                {task.owner ? (
                  <span className="ml-auto shrink-0 rounded bg-accent px-1 py-0.5 text-ui-xs text-foreground-subtle">
                    {task.owner}
                  </span>
                ) : null}
              </div>
              {task.depends.length > 0 ? (
                <p className="mt-0.5 truncate text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: "chat.teams.plan.depends" })}: {task.depends.join(" · ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      <p className="text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "chat.teams.plan.approvalHint" })}
      </p>
    </div>
  );
}
