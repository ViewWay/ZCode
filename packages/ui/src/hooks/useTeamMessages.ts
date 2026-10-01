// 全队收件箱消息流轮询 hook(v2.10 协作面板)。
// 逐成员并发轮询 inboxes/<member>.json,按 id 去重后按 sentAt 倒序(新→旧)合并。
// 磁盘事实源是 runtime;UI 只读轮询,读失败保持上一次快照,不弹错。

import { useCallback, useEffect, useRef, useState } from "react";
import type { TeamInboxMessageProjection } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";

const TEAM_MESSAGES_POLL_INTERVAL_MS = 2_500;

export interface UseTeamMessagesParams {
  workspacePath?: string;
  workspaceIdentity?: string;
  teamName?: string;
  /** 需要合并的成员名列表;以 join 键做稳定依赖,内容不变不重启轮询。 */
  memberNames: string[];
}

export interface UseTeamMessagesResult {
  messages: TeamInboxMessageProjection[];
  ready: boolean;
}

export function useTeamMessages(params: UseTeamMessagesParams): UseTeamMessagesResult {
  const services = useServices();
  const { workspacePath, workspaceIdentity, teamName } = params;
  const memberNames = params.memberNames;
  const memberKey = memberNames.join("\u0000");
  const memberNamesRef = useRef(memberNames);
  useEffect(() => {
    memberNamesRef.current = memberNames;
  }, [memberNames]);

  const [messages, setMessages] = useState<TeamInboxMessageProjection[]>([]);
  const [ready, setReady] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!workspacePath || !teamName || memberKey.length === 0 || inFlight.current) return;
    inFlight.current = true;
    try {
      const results = await Promise.all(
        memberNamesRef.current.map((memberName) =>
          services.teamsService.listInboxMessages({
            workspacePath,
            workspaceIdentity,
            teamName,
            memberName,
          }),
        ),
      );
      const merged = new Map<string, TeamInboxMessageProjection>();
      for (const result of results) {
        for (const message of result.messages) {
          merged.set(message.id, message);
        }
      }
      setMessages([...merged.values()].sort((a, b) => b.sentAt.localeCompare(a.sentAt)));
      setReady(true);
    } catch {
      // 读失败保持上一次快照。
    } finally {
      inFlight.current = false;
    }
  }, [memberKey, services, teamName, workspaceIdentity, workspacePath]);

  useEffect(() => {
    if (!workspacePath || !teamName || memberKey.length === 0) {
      setMessages([]);
      setReady(false);
      return;
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), TEAM_MESSAGES_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [memberKey, refresh, teamName, workspacePath, workspaceIdentity]);

  return { messages, ready };
}
