// 成员收件箱消息流轮询 hook(v2.9 消息流面板)。
// inboxes/<member>.json 是磁盘事实源(runtime 唯一写入者),UI 只读轮询;
// 仅在成员被选中时轮询,取消选中即停止。读失败保持上一次快照,不弹错。

import { useCallback, useEffect, useRef, useState } from "react";
import type { TeamInboxMessageProjection } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";

const TEAM_INBOX_POLL_INTERVAL_MS = 2_500;

export interface UseTeamInboxParams {
  workspacePath?: string;
  workspaceIdentity?: string;
  teamName?: string;
  memberName?: string;
  /** 选中才轮询;未选中时挂起。 */
  enabled: boolean;
}

export interface UseTeamInboxResult {
  messages: TeamInboxMessageProjection[];
  ready: boolean;
}

export function useTeamInbox(params: UseTeamInboxParams): UseTeamInboxResult {
  const services = useServices();
  const { workspacePath, workspaceIdentity, teamName, memberName, enabled } = params;
  const [messages, setMessages] = useState<TeamInboxMessageProjection[]>([]);
  const [ready, setReady] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!workspacePath || !teamName || !memberName || !enabled || inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await services.teamsService.listInboxMessages({
        workspacePath,
        workspaceIdentity,
        teamName,
        memberName,
      });
      setMessages(result.messages);
      setReady(true);
    } catch {
      // 读失败保持上一次快照。
    } finally {
      inFlight.current = false;
    }
  }, [enabled, memberName, services, teamName, workspaceIdentity, workspacePath]);

  useEffect(() => {
    if (!workspacePath || !teamName || !memberName || !enabled) {
      setMessages([]);
      setReady(false);
      return;
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), TEAM_INBOX_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, memberName, refresh, teamName, workspacePath, workspaceIdentity]);

  return { messages, ready };
}