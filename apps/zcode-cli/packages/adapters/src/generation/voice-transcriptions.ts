// ============================================================
// OpenAI 兼容语音转写端点（specs/voice-pipeline.md A2）
// ============================================================
// POST {baseUrl}/audio/transcriptions（multipart：file + model + language?）。
// 响应为 Whisper 兼容 JSON：{ text, duration?(秒), language? }。转写是只读
// 操作，源音频经端口以 base64 传入，本层不改写任何文件。

import type {
  VoicePipelineRequest,
  VoiceTranscriptionResult,
} from "@zcode/contracts";
import {
  base64ToEndpointBytes,
  callGenerationEndpoint,
  GenerationEndpointError,
  type GenerationEndpointConfig,
  joinEndpointUrl,
  readEndpointJson,
} from "./endpoint-shared.js";

export interface VoiceTranscriptionsEndpoint {
  transcribe(request: VoicePipelineRequest): Promise<VoiceTranscriptionResult>;
}

const TRANSCRIPTIONS_PATH = "audio/transcriptions";

export function createVoiceTranscriptionsEndpoint(
  config: GenerationEndpointConfig,
): VoiceTranscriptionsEndpoint {
  return {
    async transcribe(request) {
      if (request.audioBase64 === undefined) {
        throw new GenerationEndpointError({
          kind: "invalid-response",
          message: "asr_transcribe 缺少音频字节，无法构造转写请求",
        });
      }
      const mimeType = request.audioMimeType ?? "application/octet-stream";
      const form = new FormData();
      form.set("model", config.model);
      form.set(
        "file",
        new Blob([base64ToEndpointBytes(request.audioBase64)], { type: mimeType }),
        filenameForAudioMimeType(mimeType),
      );
      if (request.language) form.set("language", request.language);

      const url = joinEndpointUrl(config.baseUrl, TRANSCRIPTIONS_PATH);
      const response = await callGenerationEndpoint(config, {
        path: TRANSCRIPTIONS_PATH,
        formData: form,
      });
      const payload = (await readEndpointJson(response, url)) as {
        text?: unknown;
        duration?: unknown;
        language?: unknown;
      };
      if (typeof payload?.text !== "string") {
        throw new GenerationEndpointError({
          kind: "invalid-response",
          url,
          message: "转写端点响应缺少 text 字段",
        });
      }
      // OpenAI 兼容端点的 duration 以秒计；非数字（或缺失）时宁缺毋滥不带。
      const durationMs =
        typeof payload.duration === "number" && Number.isFinite(payload.duration)
          ? Math.round(payload.duration * 1000)
          : undefined;
      return {
        text: payload.text,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(typeof payload.language === "string" && payload.language.length > 0
          ? { language: payload.language }
          : {}),
      };
    },
  };
}

/** Whisper 家族接受的扩展名集合；未知类型回退 bin 由端点自行判定。 */
function filenameForAudioMimeType(mimeType: string): string {
  if (mimeType === "audio/mpeg" || mimeType === "audio/mp3") return "audio.mp3";
  if (mimeType === "audio/wav" || mimeType === "audio/x-wav") return "audio.wav";
  if (mimeType === "audio/webm") return "audio.webm";
  if (mimeType === "audio/mp4" || mimeType === "audio/x-m4a") return "audio.m4a";
  if (mimeType === "audio/flac") return "audio.flac";
  if (mimeType === "audio/ogg") return "audio.ogg";
  return "audio.bin";
}
