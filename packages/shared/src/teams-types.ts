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

/** v2.10 协作面板:共享任务板 tasks.json 的只读投影(runtime 唯一写入者)。 */
export interface TeamTaskProjection {
  taskId: string;
  subject: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  /** 认领成员名(TeamFile.members[].name);pending 无 owner。 */
  owner?: string;
  /** CAS 版本号(runtime 每次成功更新 +1),仅展示用。 */
  version: number;
  /** 前驱 taskId 列表;全部 completed 才可认领。 */
  blockedBy?: string[];
  /** 外部系统任务 ID(v2.8 对账锚点),仅透传。 */
  externalId?: string;
  /** ISO 时间戳。 */
  createdAt: string;
  updatedAt: string;
}

export interface TeamTasksParams extends TeamsListParams {
  teamName: string;
}

export interface TeamTasksResult {
  tasks: TeamTaskProjection[];
}

export interface TeamDashboardParams extends TeamsListParams {
  teamName: string;
}

/** 计划投影(plan.json 的宽松子集,v2.10 计划-审批-启动)。 */
export interface TeamPlanProjection {
  state: string;
  members: {
    name: string;
    prompt: string;
    reason?: string;
    difficulty?: string;
  }[];
  tasks: {
    subject: string;
    owner?: string;
    depends: string[];
  }[];
}

/** v2.10 协作面板聚合快照:roster + 任务板 + 全队收件箱 + 计划;各子集独立容忍缺失。 */
export interface TeamDashboardData {
  team: TeamRoster;
  tasks: TeamTaskProjection[];
  messages: TeamInboxMessageProjection[];
  plan?: TeamPlanProjection;
}
