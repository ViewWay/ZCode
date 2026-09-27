// ============================================================
// Agent Teams - 只读发现服务契约（specs/agent-teams.md）
// ============================================================
//
// TeamFile 的唯一写入者是 agent runtime；本服务是宿主侧只读投影，
// 供 UI roster 展示。不允许在这里新增任何写路径。

import type { TeamsListParams, TeamsListResult } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ITeamsService {
  /**
   * 列出该 workspace（按身份键隔离）下的全部团队名册。
   * 目录不存在或某个 config.json 损坏时分别容忍：前者返回空列表，后者跳过该团队。
   */
  list(params: TeamsListParams): Promise<TeamsListResult>;
}

export const ITeamsService = createServiceDescriptor<ITeamsService>(ServiceChannels.Teams);
