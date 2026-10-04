// 临时语音附件落盘（specs/voice-pipeline.md 目标 3）：renderer 麦克风录音 Blob
// 经 base64 进入 main 进程，解码后写为宿主本地文件，返回绝对路径供
// composer localPath 附件与 asr_transcribe 工具链路复用。
// 与 tempTextAttachment.ts 同族：唯一落盘通道 + `wx` 独占写 + 文件名消毒。
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getZCodeDataRootDir } from "@zcode/services/node";
import type {
  CreateTempVoiceAttachmentRequest,
  CreateTempVoiceAttachmentResult,
} from "@zcode/shared";

const TEMP_VOICE_ATTACHMENT_DIR = "voice-recordings";
/** 语音附件落盘上限：与 asr_transcribe 源读取上限同族；录音入口本身另有时长上限。 */
export const TEMP_VOICE_ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;

/** 已知录音容器 → 扩展名；未知类型按内容不可播放风险最低的 .webm 兜底。 */
const VOICE_ATTACHMENT_EXTENSIONS: ReadonlyArray<readonly [string, string]> = [
  ["audio/webm", ".webm"],
  ["audio/ogg", ".ogg"],
  ["audio/mp4", ".m4a"],
  ["audio/mpeg", ".mp3"],
  ["audio/wav", ".wav"],
];

export function resolveVoiceAttachmentExtension(mimeType: string): string {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return VOICE_ATTACHMENT_EXTENSIONS.find(([known]) => known === normalized)?.[1] ?? ".webm";
}

export async function createTempVoiceAttachment(
  payload: CreateTempVoiceAttachmentRequest,
  options: { rootDir?: string } = {},
): Promise<CreateTempVoiceAttachmentResult> {
  if (typeof payload.dataBase64 !== "string" || payload.dataBase64.length === 0) {
    throw new Error("Temporary voice attachment content is empty");
  }
  const mimeType = payload.mimeType?.trim() || "audio/webm";
  const content = Buffer.from(payload.dataBase64, "base64");
  // base64 解码对非法输入宽松（产出空 buffer），必须显式挡空与超限。
  if (content.byteLength === 0) {
    throw new Error("Temporary voice attachment content is empty");
  }
  if (content.byteLength > TEMP_VOICE_ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `Temporary voice attachment exceeds size limit (${TEMP_VOICE_ATTACHMENT_MAX_BYTES} bytes)`,
    );
  }

  const now = new Date();
  const dateDir = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join("-");
  const rootDir =
    options.rootDir ?? join(getZCodeDataRootDir(), "tmp", TEMP_VOICE_ATTACHMENT_DIR, dateDir);
  await mkdir(rootDir, { recursive: true });

  const extension = resolveVoiceAttachmentExtension(mimeType);
  const filename = buildVoiceAttachmentFilename(payload.filename, extension);
  const localPath = join(rootDir, filename);
  // `wx` 独占写：uuid 后缀防撞的同时拒绝覆盖既有文件，避免误删用户录音。
  await writeFile(localPath, content, { flag: "wx" });

  return {
    filename,
    localPath,
    mimeType,
    sizeBytes: content.byteLength,
  };
}

function buildVoiceAttachmentFilename(filename: string | undefined, extension: string): string {
  const rawBase = filename?.trim() || `voice-recording${extension}`;
  // 消毒：去 NUL/路径分隔符，并剥掉前导点号（否则 "../x" 会产出 "..-x" 这类
  // 以点开头的隐藏文件名；tempTextAttachment 未剥但语音侧直接收紧）。
  const sanitized = rawBase
    .replaceAll("\0", "-")
    .replace(/[\\/:]/gu, "-")
    .replace(/^[.\s-]+/u, "");
  const fallback = `voice-recording${extension}`;
  const normalized = sanitized.length > 0 ? sanitized : fallback;
  const safeName = normalized.toLowerCase().endsWith(extension)
    ? normalized
    : `${normalized}${extension}`;
  const suffix = randomUUID().slice(0, 8);
  const dotIndex = safeName.lastIndexOf(".");
  if (dotIndex <= 0) {
    return `${safeName}-${suffix}${extension}`;
  }
  return `${safeName.slice(0, dotIndex)}-${suffix}${safeName.slice(dotIndex)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
