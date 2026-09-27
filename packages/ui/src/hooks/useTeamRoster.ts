// Agent Teams roster 轮询 hook（specs/agent-teams.md）。
// TeamFile 是磁盘事实源（runtime 唯一写入者），UI 不缓存真相：激活期间以固定节拍
// 重读（与 Repo Wiki 的 2.5s 轮询同款取舍）。工作区没有团队时返回空数组，不视为错误。

import { useCallback, useEffect, useRef, useState } from "react";
import type { TeamRoster } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";

const TEAM_ROSTER_POLL_INTERVAL_MS = 2_500;

export interface UseTeamRosterParams {
  workspacePath?: string;
  workspaceIdentity?: string;
}

export interface UseTeamRosterResult {
  teams: TeamRoster[];
  /** 拿到过至少一次成功读取（区分「确实没有团队」与「还没读到」）。 */
  ready: boolean;
}

export function useTeamRoster(params: UseTeamRosterParams): UseTeamRosterResult {
  const services = useServices();
  const { workspacePath, workspaceIdentity } = params;
  const [teams, setTeams] = useState<TeamRoster[]>([]);
  const [ready, setReady] = useState(false);
  const inFlight = useRef(false);

  const workspaceKey = workspaceIdentity?.trim() || workspacePath;

  const refresh = useCallback(async () => {
    if (!workspaceKey || inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await services.teamsService.list({
        workspacePath: workspacePath ?? "",
        workspaceIdentity,
      });
      setTeams(result.teams);
      setReady(true);
    } catch {
      // 读失败保持上一次快照；roster 允许短暂滞后，不弹错。
    } finally {
      inFlight.current = false;
    }
  }, [services, workspaceIdentity, workspaceKey, workspacePath]);

  useEffect(() => {
    if (!workspaceKey) {
      setTeams([]);
      setReady(false);
      return;
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), TEAM_ROSTER_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, workspaceKey]);

  return { teams, ready };
}
