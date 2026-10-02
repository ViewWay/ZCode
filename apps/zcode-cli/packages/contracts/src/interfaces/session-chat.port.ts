// ============================================================
// Session Chat Port - 会话互聊（实验室）工具面的宿主能力边界
// ============================================================
// 与 AutomationPort/OffPeakPort 同族：core 的三个工具（SessionList/SessionTalk/
// SessionCreate）经此端口访问同 workspace 内的其它会话。协议 server（bootstrap
// zcode-protocol）提供实现；端口缺席即不注册工具（fail-closed，实验开关默认关闭）。
// v1 范围：仅同 CLI 进程内的 resident 会话；不跨机、不接外部非 ZCode agent。

/** SessionList 返回的最小联系人快照；不含本会话。 */
export interface SessionChatContact {
  sessionId: string;
  title: string;
  status: "idle" | "running";
  updatedAt: number;
}

/**
 * SessionTalk 投递结局。delivered 只证明输入已进入目标会话的 admission
 * （queued=true 表示目标忙、输入已排队到下一轮）；回应不在此等待——
 * 接收方模型用 SessionTalk 把回复发回来源会话（消息体携带来源标注）。
 */
export type SessionChatTalkOutcome =
  | { kind: "delivered"; targetSessionId: string; queued: boolean }
  | { kind: "rejected"; reason: "session_not_found" | "session_busy" | "invalid_target" };

/** SessionCreate 创建协作者会话的结果；sessionId 可直接作为 SessionTalk 目标。 */
export interface SessionChatCreateResult {
  sessionId: string;
}

export interface SessionChatPort {
  /** 列出当前 workspace 可互聊的存活会话（排除 excludeSessionId 指定的本会话）。 */
  listSessions(input: { excludeSessionId?: string }): Promise<SessionChatContact[]>;
  /**
   * 向目标会话投递一条标注来源的消息（以用户输入形式注入，消息体头部携带
   * 「会话互聊」来源标注，接收方 UI/模型均可识别），fire-and-return。
   */
  talkToSession(input: {
    targetSessionId: string;
    fromSessionId: string;
    /** 缺省时由端口从 session store 解析来源会话标题。 */
    fromTitle?: string;
    message: string;
  }): Promise<SessionChatTalkOutcome>;
  /** 在当前 workspace 创建一个协作者会话；firstMessage 存在时立即启动首条输入。 */
  createCollaboratorSession(input: {
    fromSessionId: string;
    /** 缺省时由端口从 session store 解析来源会话标题。 */
    fromTitle?: string;
    title?: string;
    firstMessage?: string;
  }): Promise<SessionChatCreateResult>;
}
