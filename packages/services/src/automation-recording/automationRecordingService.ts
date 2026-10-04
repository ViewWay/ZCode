import {
  ServiceChannels,
  type AutomationRecording,
  type AutomationRecordingStep,
  type AutomationRecordingCaptureStartParams,
  type AutomationRecordingCaptureState,
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

  // ---- 实时采集（v1.1，specs/record-replay.md）----
  // 活动采集会话唯一所有者是 Host 侧服务；同一时刻至多一个。

  /**
   * 开始实时采集：创建 recording scope 浏览器会话并置为可见，用户在嵌入浏览器
   * 中操作，host 轮询采集。已有活动会话、宿主未装配采集面或链路 preflight
   * 失败时抛错（诚实失败）。
   */
  startCapture(
    params?: AutomationRecordingCaptureStartParams,
  ): Promise<AutomationRecordingCaptureState>;
  /** 当前活动采集会话状态；无活动会话返回 null。 */
  getCaptureState(): Promise<AutomationRecordingCaptureState | null>;
  /**
   * 停止采集并保存：最终 drain → 步骤映射 → store.save，返回落库录制件。
   * 未捕获到任何步骤时抛错（no steps captured），不落空录制件。
   */
  stopCapture(): Promise<AutomationRecording>;
  /** 取消采集并丢弃（不落库）；无活动会话时抛错。 */
  cancelCapture(): Promise<boolean>;
  /**
   * 定时回放（v1.2）：设置/更新录制件的 cron 调度（enabled=false 暂停）；
   * undefined = 清除调度。非法 cron 抛可读错误。
   */
  setSchedule(
    recordingId: string,
    schedule: { cronExpr: string; enabled: boolean } | undefined,
  ): Promise<AutomationRecording>;
  /**
   * 步骤编辑器保存：整组替换步骤数组（seq 重排由 schema superRefine 校验，
   * 非法步骤抛可读错误）。回放按新数组执行。
   */
  updateSteps(recordingId: string, steps: AutomationRecordingStep[]): Promise<AutomationRecording>;
}

export const IAutomationRecordingService = createServiceDescriptor<IAutomationRecordingService>(
  ServiceChannels.AutomationRecording,
);
