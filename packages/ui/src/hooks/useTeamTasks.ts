// 共享任务板轮询 hook(v2.10 协作面板)。
// tasks.json 是磁盘事实源(runtime 唯一写入者),UI 只读轮询;与 useTeamRoster/useTeamInbox
// 同款取舍:固定节拍重读,读失败保持上一次快照,不弹错。

import { useCallback, useEffect, useRef, useState } from "react";
import type { TeamTaskProjection } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";

const TEAM_TASKS_POLL_INTERVAL_MS = 2_500;

export interface UseTeamTasksParams {
  workspacePath?: string;
  workspaceIdentity?: string;
  teamName?: string;
}

export interface UseTeamTasksResult {
  tasks: TeamTaskProjection[];
  ready: boolean;
}

export function useTeamTasks(params: UseTeamTasksParams): UseTeamTasksResult {
  const services = useServices();
  const { workspacePath, workspaceIdentity, teamName } = params;
  const [tasks, setTasks] = useState<TeamTaskProjection[]>([]);
  const [ready, setReady] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!workspacePath || !teamName || inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await services.teamsService.listTasks({ workspacePath, workspaceIdentity, teamName });
      setTasks(result.tasks);
      setReady(true);
    } catch {
      // 读失败保持上一次快照。
    } finally {
      inFlight.current = false;
    }
  }, [services, teamName, workspaceIdentity, workspacePath]);

  useEffect(() => {
    if (!workspacePath || !teamName) {
      setTasks([]);
      setReady(false);
      return;
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), TEAM_TASKS_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, teamName, workspacePath]);

  return { tasks, ready };
}
