// Agent Teams 侧栏区块(specs/agent-teams.md 五、UI)。
// 只读展示当前 workspace 的团队名册:成员名、活跃状态、颜色标记。
// v2.9 消息流面板:点击成员展开其收件箱消息流(谁→谁、正文、时间、已读)。
// 数据事实源是 runtime 的 TeamFile 与 inboxes/*.json,这里只消费轮询快照,不做本地编辑。

import { useState } from "react";
import { ChevronDown, ChevronRight, Network as NetworkIcon, UsersIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TeamDashboard } from "@/teams/TeamDashboard.js";
import { useTeamInbox } from "@/hooks/useTeamInbox.js";
import { useTeamRoster } from "@/hooks/useTeamRoster.js";

const TEAM_COLOR_DOT_CLASS: Record<string, string> = {
  red: "bg-red-500",
  blue: "bg-blue-500",
  green: "bg-green-500",
  yellow: "bg-yellow-500",
  purple: "bg-purple-500",
  orange: "bg-orange-500",
  pink: "bg-pink-500",
  cyan: "bg-cyan-500",
};

export function TeamRosterSection({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath?: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const { teams, ready } = useTeamRoster({ workspacePath, workspaceIdentity });
  // v2.9 消息流面板:选中的成员(teamName+memberName);选中即轮询其收件箱。
  const [selected, setSelected] = useState<{ teamName: string; memberName: string } | undefined>(undefined);
  const { messages } = useTeamInbox({
    workspacePath,
    workspaceIdentity,
    teamName: selected?.teamName,
    memberName: selected?.memberName,
    enabled: selected !== undefined,
  });
  const [expanded, setExpanded] = useState(false);
  // v2.10 协作面板:展开面板的团队名;点击团队卡片右上角的拓扑图标切换。
  const [dashboardTeam, setDashboardTeam] = useState<string | undefined>(undefined);

  // 还没读到过且工作区没有 teams 目录时保持完全隐藏,不给空工作区添噪音。
  if (!ready && teams.length === 0) {
    return null;
  }

  const totalMembers = teams.reduce((sum, team) => sum + team.members.length, 0);

  return (
    <section className="px-2 py-1" data-testid="workspace-team-roster">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-foreground-subtle" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-foreground-subtle" />
        )}
        <UsersIcon className="size-3.5 shrink-0 text-foreground-subtle" />
        <span className="min-w-0 truncate text-ui-sm font-medium text-foreground">
          {intl.formatMessage({ id: "chat.teams.title" })}
        </span>
        {teams.length > 0 ? (
          <span className="ml-auto text-ui-xs text-foreground-subtle">
            {intl.formatMessage(
              { id: "chat.teams.summary" },
              { teams: teams.length, members: totalMembers },
            )}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="space-y-2 px-2 pb-2">
          {teams.length === 0 ? (
            <p className="px-1 text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "chat.teams.empty" })}
            </p>
          ) : (
            teams.map((team) => (
              <div key={team.name} className="min-w-0 rounded-lg border border-border px-2.5 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
                    {team.name}
                  </span>
                  <span className="ml-auto shrink-0 text-ui-xs text-foreground-subtle">
                    {intl.formatMessage({ id: "chat.teams.members" }, { count: team.members.length })}
                  </span>
                  <button
                    type="button"
                    aria-label={intl.formatMessage({ id: "chat.teams.dashboard.title" })}
                    aria-expanded={dashboardTeam === team.name}
                    onClick={() =>
                      setDashboardTeam((current) => (current === team.name ? undefined : team.name))
                    }
                    className="shrink-0 rounded p-0.5 hover:bg-accent"
                  >
                    <NetworkIcon
                      className={cn(
                        "size-3.5",
                        dashboardTeam === team.name ? "text-foreground" : "text-foreground-subtle",
                      )}
                    />
                  </button>
                </div>
                <ul className="mt-1.5 space-y-1">
                  {team.members.map((member) => (
                    <li key={member.agentId} className="min-w-0">
                      <button
                        type="button"
                        onClick={() => setSelected(
                          selected?.teamName === team.name && selected?.memberName === member.name
                            ? undefined
                            : { teamName: team.name, memberName: member.name },
                        )}
                        className="flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent"
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            member.color ? TEAM_COLOR_DOT_CLASS[member.color] : "bg-foreground-subtle",
                          )}
                        />
                        <span className="min-w-0 truncate text-ui-sm text-foreground">{member.name}</span>
                        <span
                          className={cn(
                            "ml-auto shrink-0 text-ui-xs",
                            member.isActive ? "text-green-600" : "text-foreground-subtle",
                          )}
                        >
                          {intl.formatMessage({
                            id: member.isActive ? "chat.teams.active" : "chat.teams.idle",
                          })}
                        </span>
                      </button>
                      {selected !== undefined && selected.teamName === team.name && selected.memberName === member.name ? (
                        <ul className="mt-1 space-y-0.5 border-l border-border pl-2">
                          {messages.length === 0 ? (
                            <li className="text-ui-xs text-foreground-subtle">
                              {intl.formatMessage({ id: "chat.teams.inbox.empty" })}
                            </li>
                          ) : (
                            messages.map((message) => (
                              <li key={message.id} className="min-w-0 text-ui-xs">
                                <div className="flex min-w-0 items-center gap-1">
                                  <span
                                    aria-hidden
                                    className={cn(
                                      "size-1 shrink-0 rounded-full",
                                      message.read ? "bg-foreground-subtle" : "bg-blue-500",
                                    )}
                                  />
                                  <span className="min-w-0 truncate text-foreground-subtle">
                                    {message.from} → {message.to} · {message.payloadKind}
                                  </span>
                                </div>
                                {message.summary !== undefined || message.text !== undefined ? (
                                  <p className="min-w-0 whitespace-pre-wrap break-words text-foreground">
                                    {(message.text ?? message.summary ?? "").slice(0, 400)}
                                  </p>
                                ) : null}
                              </li>
                            ))
                          )}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {dashboardTeam === team.name ? (
                  <div className="mt-2 border-t border-border pt-2">
                    <TeamDashboard
                      workspacePath={workspacePath}
                      workspaceIdentity={workspaceIdentity}
                      teamName={team.name}
                    />
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}