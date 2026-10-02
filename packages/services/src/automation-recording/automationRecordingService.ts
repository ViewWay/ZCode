import {
  ServiceChannels,
  type AutomationRecording,
  type AutomationRecordingSaveParams,
  type AutomationReplayOnFailure,
  type AutomationReplayReport,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// 浏览器操作录制回放管理服务通道（specs/record-replay.md）。
// renderer 经 ProxyChannel 直连（off-peak 同款范式）；存储与回放引擎由
// Desktop 本地 Host 实现（~/.zcode/automations/），远端 Host 不提供时 UI 隐藏该区。

export interface IAutomationRecordingService {
  /** 列出全部录制件（含 steps；v1 数量小不做分页）。 */
  list(): Promise<AutomationRecording[]>;
  get(recordingId: string): Promise<AutomationRecording | null>;
  /** 保存录制件；id/createdAt 由存储层生成，返回落库后的完整对象。 */
  save(params: AutomationRecordingSaveParams): Promise<AutomationRecording>;
  delete(recordingId: string): Promise<boolean>;
  /**
   * 手动触发回放。同步返回整次回放报告（逐步状态 + 失败截图路径）；
   * 录制件损坏或不存在时抛错，不会部分执行。
   */
  replay(
    recordingId: string,
    options?: { onFailure?: AutomationReplayOnFailure },
  ): Promise<AutomationReplayReport>;
  /** 某录制件的回放报告列表（新→旧）。 */
  listReports(recordingId: string): Promise<AutomationReplayReport[]>;
}

export const IAutomationRecordingService = createServiceDescriptor<IAutomationRecordingService>(
  ServiceChannels.AutomationRecording,
);
