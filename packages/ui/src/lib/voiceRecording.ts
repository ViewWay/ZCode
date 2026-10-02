// 语音录音纯逻辑（specs/voice-pipeline.md 目标 3）：能力检测、MIME 选择、
// 错误归类、文件名与 base64 编码、落盘结果 → composer 附件的映射。
// 全部为可测纯函数；getUserMedia/MediaRecorder 的副作用留在 useVoiceRecorder hook。
import { nanoid } from "nanoid";
import type { CreateTempVoiceAttachmentResult } from "@zcode/shared";
import type { ChatComposerAttachment } from "./chatAttachments.js";

/** 单次录音上限：5 分钟；到点自动停止并产出（防忘关麦）。 */
export const VOICE_RECORDING_MAX_DURATION_MS = 5 * 60 * 1000;
/** 录音编码上限：与 main 侧 TEMP_VOICE_ATTACHMENT_MAX_BYTES 对齐，超限在编码前拦截。 */
export const VOICE_RECORDING_MAX_BYTES = 32 * 1024 * 1024;

/** 按优先级尝试的录音容器；Electron/Chromium 首选 webm+opus。 */
export const VOICE_RECORDING_MIME_CANDIDATES: readonly string[] = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

/** 已知容器 → 扩展名（与 main 侧 resolveVoiceAttachmentExtension 对齐）。 */
const VOICE_RECORDING_EXTENSIONS: ReadonlyArray<readonly [string, string]> = [
  ["audio/webm", ".webm"],
  ["audio/ogg", ".ogg"],
  ["audio/mp4", ".m4a"],
  ["audio/mpeg", ".mp3"],
  ["audio/wav", ".wav"],
];

export function resolveVoiceRecordingExtension(mimeType: string): string {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return VOICE_RECORDING_EXTENSIONS.find(([known]) => known === normalized)?.[1] ?? ".webm";
}

/** 环境探测入参：默认取 globalThis，测试可注入伪环境。 */
export interface VoiceRecordingSupportEnv {
  MediaRecorder?: unknown;
  navigator?: { mediaDevices?: { getUserMedia?: unknown } };
}

/**
 * 是否具备录音前提（getUserMedia + MediaRecorder + 可用容器）。
 * Web/SSR/受限环境返回 false，入口据此隐藏（能力检测，不报错）。
 */
export function isVoiceRecordingSupported(env: VoiceRecordingSupportEnv = globalThis): boolean {
  const mediaDevices = typeof env.navigator === "object" ? env.navigator?.mediaDevices : undefined;
  return (
    typeof mediaDevices?.getUserMedia === "function" &&
    pickVoiceRecordingMimeType(env) !== undefined
  );
}

/** 按候选序取第一个 MediaRecorder 支持的容器；都不支持返回 undefined。 */
export function pickVoiceRecordingMimeType(
  env: VoiceRecordingSupportEnv = globalThis,
): string | undefined {
  if (typeof env.MediaRecorder !== "function") return undefined;
  const isTypeSupported = (env.MediaRecorder as { isTypeSupported?: unknown }).isTypeSupported;
  if (typeof isTypeSupported !== "function") return undefined;
  const check = isTypeSupported as (mimeType: string) => boolean;
  return VOICE_RECORDING_MIME_CANDIDATES.find((candidate) => check(candidate));
}

export type VoiceRecordingErrorKind =
  | "denied"
  | "no-device"
  | "busy"
  | "aborted"
  | "empty"
  | "too-large"
  | "unsupported"
  | "unknown";

/**
 * 把 getUserMedia/MediaRecorder 异常映射为稳定错误类别，UI 按 locale 渲染可读提示。
 * fail-closed：无法归类的异常按 unknown 提示，不静默吞掉。
 */
export function resolveVoiceRecordingErrorKind(error: unknown): VoiceRecordingErrorKind {
  if (error instanceof Error) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "denied";
      case "NotFoundError":
      case "OverconstrainedError":
        return "no-device";
      case "NotReadableError":
        return "busy";
      case "AbortError":
        return "aborted";
      default:
        return "unknown";
    }
  }
  return "unknown";
}

/** `voice-YYYYMMDD-HHmmss-<rand>.<ext>`；rand 保证同秒多次录音不撞名。 */
export function buildVoiceRecordingFilename(mimeType: string, now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join("") +
    "-" +
    [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join("");
  return `voice-${stamp}-${nanoid(8)}${resolveVoiceRecordingExtension(mimeType)}`;
}

/** ArrayBuffer → base64；分块编码避免大录音一次性展开触发调用栈上限。 */
export function encodeArrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export async function encodeVoiceRecordingBlob(blob: Blob): Promise<string> {
  return encodeArrayBufferToBase64(await blob.arrayBuffer());
}

/** 落盘结果 → composer 附件：携带 localPath 走零拷贝路径，agent 按文件路径读取。 */
export function createVoiceRecordingComposerAttachment(
  result: CreateTempVoiceAttachmentResult,
): ChatComposerAttachment {
  return {
    id: nanoid(),
    filename: result.filename,
    localPath: result.localPath,
    mimeType: result.mimeType,
    sizeBytes: result.sizeBytes,
  };
}
