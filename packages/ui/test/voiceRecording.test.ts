// 语音录音纯逻辑轻测（specs/voice-pipeline.md 目标 3）：
// - 能力检测：getUserMedia/MediaRecorder/容器三者齐备才算支持；容器按候选序选择。
// - 错误归类：DOMException name → 稳定错误类别（fail-closed 提示的文案键）。
// - 文件名与扩展名、base64 编码、落盘结果 → composer 附件映射。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test packages/ui/test/voiceRecording.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  VOICE_RECORDING_MAX_DURATION_MS,
  buildVoiceRecordingFilename,
  createVoiceRecordingComposerAttachment,
  encodeArrayBufferToBase64,
  isVoiceRecordingSupported,
  pickVoiceRecordingMimeType,
  resolveVoiceRecordingErrorKind,
  resolveVoiceRecordingExtension,
} from "../src/lib/voiceRecording.js";

function makeRecorder(supported: readonly string[]) {
  return Object.assign(() => {}, {
    isTypeSupported: (mimeType: string) => supported.includes(mimeType),
  });
}

test("isVoiceRecordingSupported requires getUserMedia, MediaRecorder and a usable container", () => {
  const recorder = makeRecorder(["audio/webm;codecs=opus"]);
  assert.equal(
    isVoiceRecordingSupported({
      MediaRecorder: recorder,
      navigator: { mediaDevices: { getUserMedia: () => Promise.resolve({}) } },
    }),
    true,
  );
  // 缺 getUserMedia（Web 受限 iframe / SSR）→ 不支持，入口隐藏。
  assert.equal(isVoiceRecordingSupported({ MediaRecorder: recorder }), false);
  // 有 API 但没有可用容器 → 不支持。
  assert.equal(
    isVoiceRecordingSupported({
      MediaRecorder: makeRecorder(["audio/flac"]),
      navigator: { mediaDevices: { getUserMedia: () => Promise.resolve({}) } },
    }),
    false,
  );
});

test("pickVoiceRecordingMimeType selects the first supported candidate", () => {
  const pick = (supported: readonly string[]) =>
    pickVoiceRecordingMimeType({ MediaRecorder: makeRecorder(supported) });
  assert.equal(pick(["audio/flac"]), undefined);
  assert.equal(pick(["audio/webm"]), "audio/webm");
  assert.equal(pick(["audio/webm;codecs=opus", "audio/webm"]), "audio/webm;codecs=opus");
});

test("resolveVoiceRecordingErrorKind maps DOMException names to stable kinds", () => {
  const kind = (name: string) =>
    resolveVoiceRecordingErrorKind(Object.assign(new Error("x"), { name }));
  assert.equal(kind("NotAllowedError"), "denied");
  assert.equal(kind("SecurityError"), "denied");
  assert.equal(kind("NotFoundError"), "no-device");
  assert.equal(kind("NotReadableError"), "busy");
  assert.equal(kind("AbortError"), "aborted");
  assert.equal(kind("SomethingElseError"), "unknown");
  assert.equal(resolveVoiceRecordingErrorKind("not-an-error"), "unknown");
});

test("recording extensions follow the known container map with webm fallback", () => {
  assert.equal(resolveVoiceRecordingExtension("audio/webm;codecs=opus"), ".webm");
  assert.equal(resolveVoiceRecordingExtension("audio/mp4"), ".m4a");
  assert.equal(resolveVoiceRecordingExtension("audio/mpeg"), ".mp3");
  assert.equal(resolveVoiceRecordingExtension("audio/unknown"), ".webm");
});

test("buildVoiceRecordingFilename is timestamped, suffixed and extension-aware", () => {
  const now = new Date(2026, 9, 3, 15, 4, 5);
  const name = buildVoiceRecordingFilename("audio/webm;codecs=opus", now);
  assert.match(name, /^voice-20261003-150405-[a-zA-Z0-9_-]{8}\.webm$/);
  const other = buildVoiceRecordingFilename("audio/webm;codecs=opus", now);
  assert.notEqual(name, other, "same-second recordings must not collide");
});

test("encodeArrayBufferToBase64 roundtrips through Buffer", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  const encoded = encodeArrayBufferToBase64(bytes.buffer);
  assert.equal(Buffer.from(encoded, "base64").toString("hex"), Buffer.from(bytes).toString("hex"));
  // 分块边界：超过 0x8000 的输入仍完整编码。
  const large = new Uint8Array(0x8000 + 17);
  large.fill(7, 0x8000 - 3);
  assert.equal(
    Buffer.from(encodeArrayBufferToBase64(large.buffer), "base64").byteLength,
    large.byteLength,
  );
});

test("createVoiceRecordingComposerAttachment carries the host path as localPath", () => {
  const attachment = createVoiceRecordingComposerAttachment({
    filename: "voice-1.webm",
    localPath: "/tmp/zcode/voice-1.webm",
    mimeType: "audio/webm",
    sizeBytes: 1024,
  });
  assert.equal(attachment.localPath, "/tmp/zcode/voice-1.webm");
  assert.equal(attachment.filename, "voice-1.webm");
  assert.equal(attachment.mimeType, "audio/webm");
  assert.equal(attachment.sizeBytes, 1024);
  assert.ok(attachment.id, "attachment id is generated for the upload scope");
});

test("recording duration cap stays at 5 minutes", () => {
  assert.equal(VOICE_RECORDING_MAX_DURATION_MS, 5 * 60 * 1000);
});
