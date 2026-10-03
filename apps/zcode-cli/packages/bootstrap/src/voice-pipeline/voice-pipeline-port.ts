// ============================================================
// Voice Pipeline Port - 语音转写/合成端口本地实现（specs/voice-pipeline.md）
// ============================================================
// CLI 进程内本地装配（provider 配置在同一进程）。配置驱动：transcribe 扫
// capabilities.transcription、synthesize 扫 capabilities.speech（ASR 与 TTS
// 是不同模型，故独立扫描；扫描与组装见 generation-capability.ts），命中后
// 交给 adapters 的 OpenAI 兼容语音端点（/audio/transcriptions、/audio/speech）
// 调用；未命中保持可读未配置错误，不发起任何网络请求。超时取 core 的
// VOICE_TOOL_TIMEOUT_MS。

import {
  createVoiceSynthesesEndpoint,
  createVoiceTranscriptionsEndpoint,
} from "@zcode/adapters/generation";
import { VOICE_TOOL_TIMEOUT_MS } from "@zcode/core";
import type {
  VoicePipelinePort,
  VoicePipelineRequest,
  VoiceSynthesisResult,
  VoiceTranscriptionResult,
} from "@zcode/contracts";
import {
  composeGenerationEndpointConfig,
  type LocalGenerationPortDeps,
} from "../generation-capability.js";

const TRANSCRIPTION_UNCONFIGURED =
  "语音转写端点未配置：请在设置中为某个 provider 的模型条目声明转写能力（properties.capabilities.transcription）后再使用 asr_transcribe。";
const SPEECH_UNCONFIGURED =
  "语音合成端点未配置：请在设置中为某个 provider 的模型条目声明合成能力（properties.capabilities.speech）后再使用 tts_speech。";

export function createLocalVoicePipelinePort(
  deps: LocalGenerationPortDeps,
): VoicePipelinePort {
  return {
    async transcribe(request: VoicePipelineRequest): Promise<VoiceTranscriptionResult> {
      const endpoint = createVoiceTranscriptionsEndpoint(
        composeGenerationEndpointConfig(
          deps,
          "transcription",
          TRANSCRIPTION_UNCONFIGURED,
          VOICE_TOOL_TIMEOUT_MS,
        ),
      );
      return endpoint.transcribe(request);
    },
    async synthesize(request: VoicePipelineRequest): Promise<VoiceSynthesisResult> {
      const endpoint = createVoiceSynthesesEndpoint(
        composeGenerationEndpointConfig(deps, "speech", SPEECH_UNCONFIGURED, VOICE_TOOL_TIMEOUT_MS),
      );
      return endpoint.synthesize(request);
    },
  };
}
