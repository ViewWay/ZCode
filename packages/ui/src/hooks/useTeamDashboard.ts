// 协作面板组合 hook(v2.10):roster → 选定团队 → 任务板 + 全队收件箱。
// useTeamRoster/useTeamTasks/useTeamMessages 各自 2.5s 轮询,这里只做组合与选队。
// teamName 未指定时选 roster 中的第一个团队(list 已按名称排序,选择稳定)。

import { useMemo } from "react";
import type { TeamInboxMessageProjection, TeamRoster, TeamTaskProjection } from "@zcode/shared";
import { useTeamMessages } from "@/hooks/useTeamMessages.js";
import { useTeamRoster } from "@/hooks/useTeamRoster.js";
import { useTeamTasks } from "@/hooks/useTeamTasks.js";

export interface UseTeamDashboardParams {
  workspacePath?: string;
  workspaceIdentity?: string;
  teamName?: string;
}

export interface UseTeamDashboardResult {
  team: TeamRoster | undefined;
  tasks: TeamTaskProjection[];
  messages: TeamInboxMessageProjection[];
  ready: boolean;
}

export function useTeamDashboard(params: UseTeamDashboardParams): UseTeamDashboardResult {
  const { workspacePath, workspaceIdentity, teamName } = params;
  const { teams, ready } = useTeamRoster({ workspacePath, workspaceIdentity });
  // teamName 未指定时选 roster 首个团队;teamName 指定但不在名册时返回 undefined。
  const team = useMemo(() => {
    if (teamName !== undefined) {
      return teams.find((candidate) => candidate.name === teamName);
    }
    return teams[0];
  }, [teamName, teams]);

  const resolvedTeamName = team?.name;
  const { tasks } = useTeamTasks({ workspacePath, workspaceIdentity, teamName: resolvedTeamName });
  const memberNames = useMemo(() => team?.members.map((member) => member.name) ?? [], [team]);
  const { messages } = useTeamMessages({
    workspacePath,
    workspaceIdentity,
    teamName: resolvedTeamName,
    memberNames,
  });
  return { team, tasks, messages, ready };
}
