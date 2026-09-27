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
