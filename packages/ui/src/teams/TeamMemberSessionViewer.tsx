// 成员会话查看器:按 TeamRosterMember.sessionId 只读回放该成员的会话消息。
// 数据走既有 IZCodeSessionService.readSessionMessages(宿主零改动、只读查询);
// getZCodeUserVisibleMessages 过滤 runtime 注入的合成上下文,回放只保留真实对话。
// 展开期间与收件箱面板同节拍轮询;读失败保持上一次快照,不弹错。

import { useCallback, useEffect, useRef, useState } from "react";
import type { TeamRosterMember, ZCodeMessageWithParts } from "@zcode/shared";
import { getZCodeUserVisibleMessages, textFromZCodeMessageParts } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";

const MEMBER_SESSION_POLL_INTERVAL_MS = 2_500;
const MEMBER_SESSION_MESSAGE_LIMIT = 200;

/** "9:05" 风格短时间;非法时间戳兜底为空串。 */
function formatMessageTime(createdMs: number): string {
  const date = new Date(createdMs);
  if (Number.isNaN(date.getTime())) return "";
  const pad2 = (value: number) => String(value).padStart(2, "0");
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function TeamMemberSessionViewer({
  workspacePath,
  workspaceIdentity,
  teamName,
  member,
}: {
  workspacePath?: string;
  workspaceIdentity?: string;
  teamName: string;
  member: TeamRosterMember;
}) {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const sessionId = member.sessionId;
  const [messages, setMessages] = useState<ZCodeMessageWithParts[]>([]);
  const [ready, setReady] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!workspacePath || !sessionId || inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await services.zcodeSessionService.readSessionMessages({
        workspacePath,
        workspaceIdentity,
        sessionId,
        limit: MEMBER_SESSION_MESSAGE_LIMIT,
      });
      setMessages(result);
      setReady(true);
    } catch {
      // 读失败保持上一次快照;会话可能已结束,不弹错。
    } finally {
      inFlight.current = false;
    }
  }, [services, sessionId, workspaceIdentity, workspacePath]);

  useEffect(() => {
    if (!workspacePath || !sessionId) {
      setMessages([]);
      setReady(false);
      return;
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), MEMBER_SESSION_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, sessionId, workspacePath]);

  // 正序回放(旧→新);可见投影滤掉合成上下文后,再补一层文本非空过滤。
  const visible = getZCodeUserVisibleMessages(messages)
    .filter((message) => textFromZCodeMessageParts(message.parts).trim().length > 0)
    .sort((a, b) => a.info.time.created - b.info.time.created);

  return (
    <div className="min-w-0 space-y-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-ui-xs font-medium text-foreground">
          {intl.formatMessage({ id: "chat.teams.session.title" })}
        </span>
        <span className="ml-auto shrink-0 text-ui-xs text-foreground-subtle">{teamName}</span>
      </div>
      {sessionId === undefined ? (
        <p className="px-1 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "chat.teams.session.noSession" })}
        </p>
      ) : ready && visible.length === 0 ? (
        <p className="px-1 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "chat.teams.session.empty" })}
        </p>
      ) : (
        <ul className="space-y-1">
          {visible.map((message) => {
            const text = textFromZCodeMessageParts(message.parts).trim();
            return (
              <li key={message.info.messageId} className="min-w-0 text-ui-xs">
                <div className="flex min-w-0 items-center gap-1">
                  <span
                    className={cn(
                      "shrink-0 font-medium",
                      message.info.role === "assistant" ? "text-blue-500" : "text-foreground-subtle",
                    )}
                  >
                    {intl.formatMessage({
                      id:
                        message.info.role === "assistant"
                          ? "chat.teams.session.roleAssistant"
                          : "chat.teams.session.roleUser",
                    })}
                  </span>
                  <span className="ml-auto shrink-0 text-foreground-subtle">
                    {formatMessageTime(message.info.time.created)}
                  </span>
                </div>
                <p className="min-w-0 whitespace-pre-wrap break-words text-foreground">
                  {text.slice(0, 500)}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
