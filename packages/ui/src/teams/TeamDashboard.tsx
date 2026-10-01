// 团队协作可视化面板(v2.10):状态栏 + 编队拓扑 + 任务 DAG + 通讯面板。
// 数据经 useTeamDashboard 组合轮询(2.5s):roster → 选定团队 → 任务板 + 全队收件箱。
// 磁盘事实源在 runtime;本组件只读展示。teamName 缺省时选 roster 首个团队(list 已按名排序)。

import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTeamDashboard } from "@/hooks/useTeamDashboard.js";
import { TaskDependencyGraph } from "@/teams/TaskDependencyGraph.js";
import { TeamCommunicationFeed } from "@/teams/TeamCommunicationFeed.js";
import { TeamFormationChart } from "@/teams/TeamFormationChart.js";
import { TeamStatusBar } from "@/teams/TeamStatusBar.js";

export function TeamDashboard({
  workspacePath,
  workspaceIdentity,
  teamName,
}: {
  workspacePath?: string;
  workspaceIdentity?: string;
  teamName?: string;
}) {
  const { intl } = useZCodeIntl();
  const { team, tasks, messages } = useTeamDashboard({ workspacePath, workspaceIdentity, teamName });

  // teamName 指定但不在名册(刚解散/身份键不匹配)或名册未就绪时,展示与侧栏一致的空态。
  if (team === undefined) {
    return (
      <p className="px-1 text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "chat.teams.empty" })}
      </p>
    );
  }

  // 侧栏容器较窄,四个子模块纵向堆叠;通讯面板收尾。
  return (
    <div className="min-w-0 space-y-2">
      <TeamStatusBar tasks={tasks} teamName={team.name} />
      <TeamFormationChart team={team} tasks={tasks} />
      <TaskDependencyGraph tasks={tasks} />
      <TeamCommunicationFeed messages={messages} />
    </div>
  );
}
