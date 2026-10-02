// ============================================================
// Voice Pipeline Port - 语音转写/合成端口（specs/voice-pipeline.md）
// ============================================================
// asr_transcribe / tts_speech 的执行端口，与 ImageGenerationPort 同族：
// bootstrap 进程内本地装配（无需协议转发）。v1 为配置驱动占位：未配置语音
// 端点时返回可读错误（端点默认值与模型名为产品待定项），seam 预留 adapters
// 接入。端口缺席时 core 不注册工具（fail-closed）。

/** 转写结果。 */
export interface VoiceTranscriptionResult {
  text: string;
  durationMs?: number;
  language?: string;
}

/** 合成结果：音频字节 base64 交付，落盘经 ToolArtifactStorePort（唯一落盘点）。 */
export interface VoiceSynthesisResult {
  audioBase64: string;
  mimeType: string;
  durationMs?: number;
}

export interface VoicePipelineRequest {
  /** 转写：音频原始字节 base64。 */
  audioBase64?: string;
  audioMimeType?: string;
  /** 合成：待读文本。 */
  text?: string;
  /** 端点侧音色；缺省用端点默认。 */
  voice?: string;
  /** 语言提示（如 "zh-CN"）；可选。 */
  language?: string;
}

/**
 * 语音转写/合成端口。实现方自行兜底：不可用时抛可读 Error（core 映射为
 * 可恢复工具失败），不允许未归类错误阻断 turn。
 */
export interface VoicePipelinePort {
  transcribe(request: VoicePipelineRequest): Promise<VoiceTranscriptionResult>;
  synthesize(request: VoicePipelineRequest): Promise<VoiceSynthesisResult>;
}
