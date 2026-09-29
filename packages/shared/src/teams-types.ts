// ============================================================
// Agent Teams - 团队名册共享类型（specs/agent-teams.md）
// ============================================================
//
// TeamFile（<home>/.zcode/teams/<workspace-key>/<team-name>/config.json）由 agent
// runtime 唯一写入；本文件只定义 services 只读发现与 UI roster 消费的投影类型。
// 解析必须容忍缺字段/多余字段（runtime 与本包版本可能不同步），不做严格校验。

import type { AgentColor } from "./subagents-types.js";

export interface TeamRosterMember {
  name: string;
  agentId: string;
  isActive: boolean;
  color?: AgentColor;
  permissionMode?: string;
  cwd?: string;
  sessionId?: string;
  /** ISO 时间戳（runtime 落盘为 new Date().toISOString()）。 */
  joinedAt?: string;
}

export interface TeamRoster {
  name: string;
  description?: string;
  leadAgentId?: string;
  /** ISO 时间戳。 */
  createdAt?: string;
  members: TeamRosterMember[];
}

export interface TeamsListParams {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface TeamsListResult {
  teams: TeamRoster[];
}

/** v2.9 消息流面板:成员收件箱消息的只读投影。事实源 inboxes/<member>.json(runtime 唯一写入)。 */
export interface TeamInboxMessageProjection {
  id: string;
  from: string;
  to: string;
  summary?: string;
  /** text 载荷的正文;非 text 载荷省略。 */
  text?: string;
  /** text / shutdown_request / shutdown_response / idle_notification / task_notification / plan_approval_* */
  payloadKind: string;
  /** task_notification 的任务状态(completed/cancelled/pending)。 */
  status?: string;
  sentAt: string;
  read: boolean;
}

export interface TeamInboxParams extends TeamsListParams {
  teamName: string;
  memberName: string;
}

export interface TeamInboxResult {
  memberName: string;
  messages: TeamInboxMessageProjection[];
}
