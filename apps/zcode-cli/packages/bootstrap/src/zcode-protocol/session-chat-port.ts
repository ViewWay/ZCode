// ============================================================
// Session Chat 协议端口 - 会话互聊（实验）工具面的宿主实现
// ============================================================
// 与 offpeak-port 同族：tool handler 经 SessionChatPort 访问同 workspace 的
// 其它会话；本实现跑在协议 server 进程内，直接读写 context.sessions 注册表
// （同 workspace 的 resident 会话全在本进程，无需跨进程 RPC）。
// - SessionList：resident 记录过滤出侧栏可见的主会话（TASK_LIST_SESSION_TYPES），
//   标题从 session store 解析（与旧 listSessions op 同源）。
// - SessionTalk：以用户输入形式注入目标会话（app.sendInput，v4 sendText 同款
//   fire-and-return admission 语义），消息体头部携带来源标注——接收方 UI 与模型
//   都能看出这条输入来自另一个会话的模型而非用户；回信指引让对方用 SessionTalk 发回。
// - SessionCreate：复用 v4 createSessionRecordForV4（经注入避免与本模块循环依赖），
//   建协作者会话；firstMessage 存在时立即以同款标注投递首条输入。
// 安全：目标必须同 workspace 的 resident 主会话；不触碰 agent-teams 状态。

import type { SessionChatContact, SessionChatPort, SessionChatTalkOutcome } from "@zcode/contracts";
import type { SessionId } from "@zcode/contracts";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { TASK_LIST_SESSION_TYPES } from "../zcode-protocol-v4/task-list-session-membership.js";

const CHAT_VISIBLE_SESSION_TYPES: ReadonlySet<string> = new Set(TASK_LIST_SESSION_TYPES);

/** 会话互聊注入消息的来源标注头；接收方 UI/模型凭此区分「另一会话的模型」与用户输入。 */
export function buildSessionChatMessage(input: {
  fromSessionId: string;
  fromTitle: string;
  message: string;
}): string {
  const title = input.fromTitle.trim();
  return [
    "[Session Inter-Chat / 会话互聊]",
    `This message is from the MODEL of another session in this workspace ("${title}", sessionId ${input.fromSessionId}) — not from the user.`,
    `To reply, call SessionTalk with targetSessionId "${input.fromSessionId}".`,
    "---",
    input.message,
  ].join("\n");
}

async function resolveSessionTitle(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<string> {
  const store = context.deps.sessionStore;
  if (!store) return "";
  try {
    const info = await store.getSession(sessionId as SessionId);
    return info?.title?.trim() ?? "";
  } catch {
    // 标题仅用于可读性；store 瞬时故障不阻断互聊。
    return "";
  }
}

function isChatVisibleRecord(record: ZCodeProtocolSessionRecord): boolean {
  // deferred 草稿未发送首条消息，不是可互聊的「存活会话」；
  // 可见性与侧栏同源（TASK_LIST_SESSION_TYPES），subagent/workflow child 等内部会话不可呼。
  return (
    record.persistence !== "deferred" && CHAT_VISIBLE_SESSION_TYPES.has(record.taskType ?? "interactive")
  );
}

export function createProtocolSessionChatPort(
  context: ZCodeProtocolAgentServerContext,
  resolveOwnSession: () => ZCodeProtocolSessionRecord | undefined,
  deps: {
    /** v4 createSessionRecordForV4（server-operations 注入，避免模块循环依赖）。 */
    createRecord: (rawParams: unknown) => Promise<{ sessionId: string }>;
  },
): SessionChatPort {
  return {
    async listSessions(input: { excludeSessionId?: string }): Promise<SessionChatContact[]> {
      const contacts: SessionChatContact[] = [];
      for (const [sessionId, record] of context.sessions) {
        if (!isChatVisibleRecord(record)) continue;
        if (input.excludeSessionId && sessionId === input.excludeSessionId) continue;
        contacts.push({
          sessionId,
          title: await resolveSessionTitle(context, sessionId),
          status: record.activeAbortController !== undefined ? "running" : "idle",
          updatedAt: record.updatedAt,
        });
      }
      // 最近活跃优先，帮助模型从多人列表里先看到正在工作的协作者。
      contacts.sort((a, b) => b.updatedAt - a.updatedAt);
      return contacts;
    },

    async talkToSession(input: {
      targetSessionId: string;
      fromSessionId: string;
      fromTitle?: string;
      message: string;
    }): Promise<SessionChatTalkOutcome> {
      const target = context.sessions.get(input.targetSessionId);
      if (!target) {
        return { kind: "rejected", reason: "session_not_found" };
      }
      if (!isChatVisibleRecord(target) || input.targetSessionId === input.fromSessionId) {
        return { kind: "rejected", reason: "invalid_target" };
      }
      const fromTitle = input.fromTitle?.trim() || (await resolveSessionTitle(context, input.fromSessionId));
      const own = resolveOwnSession();
      // 同进程注册表按 sessionId 隔离；own 缺席（会话已被回收）仍允许投递——
      // 来源标注按 fromSessionId/stable 标题描述，不依赖 own record 存活。
      if (own && own.workspace.workspaceKey !== target.workspace.workspaceKey) {
        return { kind: "rejected", reason: "invalid_target" };
      }
      const text = buildSessionChatMessage({
        fromSessionId: input.fromSessionId,
        fromTitle: fromTitle || input.fromSessionId,
        message: input.message,
      });
      try {
        // fire-and-return（v4 sendText 同款）：admission 完成即返回，不等待 turn 结束；
        // 目标忙时 Core admission 会把输入排队到下一轮（kind: "queued"）。
        const admission = await target.app.sendInput(
          { text },
          { inputId: `session-chat:${crypto.randomUUID()}` },
        );
        if (admission.kind === "rejected") {
          return { kind: "rejected", reason: "session_busy" };
        }
        return { kind: "delivered", targetSessionId: input.targetSessionId, queued: admission.kind !== "started_turn" };
      } catch (error) {
        context.logger?.warn("SessionChat delivery failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "session_chat.talk.failed",
          sessionId: input.targetSessionId,
        });
        return { kind: "rejected", reason: "session_busy" };
      }
    },

    async createCollaboratorSession(input: {
      fromSessionId: string;
      fromTitle?: string;
      title?: string;
      firstMessage?: string;
    }): Promise<{ sessionId: string }> {
      const own = resolveOwnSession();
      if (!own) {
        throw new Error("Session chat requires an active source session record.");
      }
      // 复用 v4 createSession 的执行面（record 建立/事件接线/失败自清理都在其内）；
      // immediate 持久化让协作者会话直接进侧栏，parentSessionId 记录协作谱系。
      const created = await deps.createRecord({
        workspace: own.workspace,
        persistence: "immediate",
        parentSessionId: input.fromSessionId,
        titleGenerationEnabled: true,
      });
      const record = context.sessions.get(created.sessionId);
      if (!record) {
        throw new Error("Session chat collaborator session was not registered.");
      }
      if (input.title) {
        try {
          await record.app.setCustomSessionTitle({ title: input.title });
        } catch (error) {
          context.logger?.warn("SessionChat custom title failed; keeping default title", {
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "session_chat.create.title_failed",
            sessionId: created.sessionId,
          });
        }
      }
      if (input.firstMessage) {
        const fromTitle = input.fromTitle?.trim() || (await resolveSessionTitle(context, input.fromSessionId));
        const admission = await record.app.sendInput(
          {
            text: buildSessionChatMessage({
              fromSessionId: input.fromSessionId,
              fromTitle: fromTitle || input.fromSessionId,
              message: input.firstMessage,
            }),
          },
          { inputId: `session-chat:${crypto.randomUUID()}` },
        );
        if (admission.kind === "rejected") {
          throw new Error("Session chat collaborator first message was rejected.");
        }
      }
      context.logger?.info("SessionChat collaborator session created", {
        event: "session_chat.create.completed",
        fromSessionId: input.fromSessionId,
        hasFirstMessage: Boolean(input.firstMessage),
        sessionId: created.sessionId,
        workspaceKey: own.workspace.workspaceKey,
      });
      return { sessionId: created.sessionId };
    },
  };
}
