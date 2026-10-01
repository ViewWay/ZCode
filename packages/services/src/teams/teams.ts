// ============================================================
// Agent Teams - 只读发现服务契约（specs/agent-teams.md）
// ============================================================
//
// TeamFile 的唯一写入者是 agent runtime；本服务是宿主侧只读投影，
// 供 UI roster 展示。不允许在这里新增任何写路径。

import type {
  TeamDashboardData,
  TeamDashboardParams,
  TeamInboxParams,
  TeamInboxResult,
  TeamTasksParams,
  TeamTasksResult,
  TeamsListParams,
  TeamsListResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ITeamsService {
  /**
   * 列出该 workspace(按身份键隔离)下的全部团队名册。
   * 目录不存在或某个 config.json 损坏时分别容忍:前者返回空列表,后者跳过该团队。
   */
  list(params: TeamsListParams): Promise<TeamsListResult>;
  /**
   * 读取成员收件箱消息(v2.9 消息流面板;只读投影,runtime 唯一写入)。
   * 收件箱不存在或损坏时容忍并返回空列表(与 list 同款取舍)。
   */
  listInboxMessages(params: TeamInboxParams): Promise<TeamInboxResult>;
  /**
   * 读取共享任务板 tasks.json 的只读投影(v2.10 协作面板)。
   * 文件不存在或损坏时容忍并返回空列表(与 list 同款取舍)。
   */
  listTasks(params: TeamTasksParams): Promise<TeamTasksResult>;
  /**
   * 聚合 roster + 任务板 + 全队收件箱合并 + plan.json 的只读快照(v2.10 协作面板)。
   * 任一子集缺失/损坏时容忍:对应子集为空或省略,不阻断整体。
   */
  getDashboard(params: TeamDashboardParams): Promise<TeamDashboardData>;
}

export const ITeamsService = createServiceDescriptor<ITeamsService>(ServiceChannels.Teams);
