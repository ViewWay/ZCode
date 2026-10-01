// 团队计划轮询 hook(v2.10 计划-审批面板)。
// plan.json 是磁盘事实源(runtime 唯一写入者),UI 只读轮询;与 useTeamTasks
// 同款取舍:固定节拍重读,读失败保持上一次快照,不弹错。计划不存在时 plan 省略。

import { useCallback, useEffect, useRef, useState } from "react";
import type { TeamPlanProjection } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";

const TEAM_PLAN_POLL_INTERVAL_MS = 2_500;

export interface UseTeamPlanParams {
  workspacePath?: string;
  workspaceIdentity?: string;
  teamName?: string;
}

export interface UseTeamPlanResult {
  plan: TeamPlanProjection | undefined;
  ready: boolean;
}

export function useTeamPlan(params: UseTeamPlanParams): UseTeamPlanResult {
  const services = useServices();
  const { workspacePath, workspaceIdentity, teamName } = params;
  const [plan, setPlan] = useState<TeamPlanProjection | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!workspacePath || !teamName || inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await services.teamsService.getTeamPlan({ workspacePath, workspaceIdentity, teamName });
      setPlan(result.plan);
      setReady(true);
    } catch {
      // 读失败保持上一次快照。
    } finally {
      inFlight.current = false;
    }
  }, [services, teamName, workspaceIdentity, workspacePath]);

  useEffect(() => {
    if (!workspacePath || !teamName) {
      setPlan(undefined);
      setReady(false);
      return;
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), TEAM_PLAN_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, teamName, workspacePath]);

  return { plan, ready };
}
