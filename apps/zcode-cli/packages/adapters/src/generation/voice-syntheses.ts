// ============================================================
// OpenAI 兼容语音合成端点（specs/voice-pipeline.md A2）
// ============================================================
// POST {baseUrl}/audio/speech（JSON：model + input + voice?）。响应体为音频
// 字节（OpenAI 默认 mp3），MIME 依响应 Content-Type 判定、缺省 audio/mpeg。

import type { VoicePipelineRequest, VoiceSynthesisResult } from "@zcode/contracts";
import {
  callGenerationEndpoint,
  GenerationEndpointError,
  type GenerationEndpointConfig,
  joinEndpointUrl,
  readEndpointBytes,
} from "./endpoint-shared.js";

export interface VoiceSynthesesEndpoint {
  synthesize(request: VoicePipelineRequest): Promise<VoiceSynthesisResult>;
}

const SPEECH_PATH = "audio/speech";
/** OpenAI 兼容 /audio/speech 的默认输出格式是 mp3。 */
const DEFAULT_SPEECH_MIME_TYPE = "audio/mpeg";

export function createVoiceSynthesesEndpoint(
  config: GenerationEndpointConfig,
): VoiceSynthesesEndpoint {
  return {
    async synthesize(request) {
      if (request.text === undefined || request.text.length === 0) {
        throw new GenerationEndpointError({
          kind: "invalid-response",
          message: "tts_speech 缺少待合成文本，无法构造合成请求",
        });
      }
      const url = joinEndpointUrl(config.baseUrl, SPEECH_PATH);
      // voice 缺席时由端点默认；OpenAI 官方要求 voice，缺失会以 4xx 归一化报出。
      const response = await callGenerationEndpoint(config, {
        path: SPEECH_PATH,
        body: {
          model: config.model,
          input: request.text,
          ...(request.voice ? { voice: request.voice } : {}),
        },
      });
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      // 个别网关用 200 + JSON 报错；音频端点不应返回 JSON，提前拦下避免把错误体当音频落盘。
      if (contentType === "application/json") {
        throw new GenerationEndpointError({
          kind: "invalid-response",
          url,
          message: "语音合成端点返回了 JSON 而非音频字节",
        });
      }
      const bytes = await readEndpointBytes(response);
      if (bytes.byteLength === 0) {
        throw new GenerationEndpointError({
          kind: "invalid-response",
          url,
          message: "语音合成端点返回空音频体",
        });
      }
      return {
        audioBase64: Buffer.from(bytes).toString("base64"),
        mimeType: contentType && contentType.startsWith("audio/")
          ? contentType
          : DEFAULT_SPEECH_MIME_TYPE,
      };
    },
  };
}
