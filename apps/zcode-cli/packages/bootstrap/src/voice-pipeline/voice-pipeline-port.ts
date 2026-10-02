// ============================================================
// Voice Pipeline Port - 语音转写/合成端口本地实现（specs/voice-pipeline.md）
// ============================================================
// CLI 进程内本地装配（provider 配置在同一进程）。v1 为配置驱动占位：
// 未配置语音端点时返回可读错误（端点默认值与模型名为产品待定项）；
// 产品确认后在本文件 seam 注释处接入 adapters 语音端点调用。

import type {
  VoicePipelinePort,
  VoicePipelineRequest,
  VoiceSynthesisResult,
  VoiceTranscriptionResult,
} from "@zcode/contracts";

/** v1 端点未配置的可读指引。 */
const VOICE_ENDPOINT_UNCONFIGURED =
  "语音端点未配置：请在设置中为某个 provider 配置语音模型（默认端点与模型名为产品待定项）。";

/** 端点配置 seam：产品确认默认语音端点/模型后，在此接入 adapters 语义端点调用。 */
export function createLocalVoicePipelinePort(): VoicePipelinePort {
  return {
    async transcribe(_request: VoicePipelineRequest): Promise<VoiceTranscriptionResult> {
      throw new Error(VOICE_ENDPOINT_UNCONFIGURED);
    },
    async synthesize(_request: VoicePipelineRequest): Promise<VoiceSynthesisResult> {
      throw new Error(VOICE_ENDPOINT_UNCONFIGURED);
    },
  };
}
