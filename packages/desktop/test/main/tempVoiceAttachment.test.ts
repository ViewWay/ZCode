// 临时语音附件落盘单测（specs/voice-pipeline.md 目标 3）：真实文件系统，
// 注入 rootDir 隔离 tmp 目录。覆盖：读写回环、空/超限拒绝、文件名消毒与
// 扩展名归一、`wx` 独占写不覆盖。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test packages/desktop/test/main/tempVoiceAttachment.test.ts

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  TEMP_VOICE_ATTACHMENT_MAX_BYTES,
  createTempVoiceAttachment,
  resolveVoiceAttachmentExtension,
} from "../../src/main/tempVoiceAttachment.js";

async function makeRootDir() {
  return mkdtemp(join(tmpdir(), "zcode-temp-voice-attachment-"));
}

test("writes base64 audio payload and returns a readable host path", async () => {
  const rootDir = await makeRootDir();
  try {
    const payload = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x01]);
    const result = await createTempVoiceAttachment(
      { dataBase64: payload.toString("base64"), mimeType: "audio/webm;codecs=opus" },
      { rootDir },
    );
    assert.match(result.filename, /\.webm$/);
    assert.ok(result.localPath.startsWith(rootDir));
    assert.equal(result.mimeType, "audio/webm;codecs=opus");
    assert.equal(result.sizeBytes, payload.byteLength);
    assert.deepEqual(await readFile(result.localPath), payload);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("rejects empty payloads instead of writing an unplayable file", async () => {
  const rootDir = await makeRootDir();
  try {
    await assert.rejects(
      createTempVoiceAttachment({ dataBase64: "", mimeType: "audio/webm" }, { rootDir }),
      /empty/u,
    );
    // 非法 base64 解码为空 buffer，同样必须拒绝（fail-closed，不落空文件）。
    await assert.rejects(
      createTempVoiceAttachment({ dataBase64: "!!!!", mimeType: "audio/webm" }, { rootDir }),
      /empty/u,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("rejects oversized payloads with the documented limit", async () => {
  const rootDir = await makeRootDir();
  try {
    const oversize = Buffer.alloc(TEMP_VOICE_ATTACHMENT_MAX_BYTES + 1, 1);
    await assert.rejects(
      createTempVoiceAttachment(
        { dataBase64: oversize.toString("base64"), mimeType: "audio/webm" },
        { rootDir },
      ),
      /size limit/u,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("normalizes filename and extension from the provided hint", async () => {
  const rootDir = await makeRootDir();
  try {
    const result = await createTempVoiceAttachment(
      {
        dataBase64: Buffer.from("ab").toString("base64"),
        mimeType: "audio/mp4",
        filename: "../evil:name",
      },
      { rootDir },
    );
    assert.match(result.filename, /^evil-name-[0-9a-f]{8}\.m4a$/);
    assert.ok(!result.localPath.includes(".."), "path traversal must be neutralized");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("never overwrites an existing file (wx exclusive write)", async () => {
  const rootDir = await makeRootDir();
  try {
    const first = await createTempVoiceAttachment(
      { dataBase64: Buffer.from("first").toString("base64"), mimeType: "audio/webm" },
      { rootDir },
    );
    const second = await createTempVoiceAttachment(
      { dataBase64: Buffer.from("second").toString("base64"), mimeType: "audio/webm" },
      { rootDir },
    );
    assert.notEqual(second.localPath, first.localPath, "uuid suffix must prevent collisions");
    assert.equal((await readFile(first.localPath)).toString(), "first");
    assert.equal((await readFile(second.localPath)).toString(), "second");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("extension map follows known containers with webm fallback", () => {
  assert.equal(resolveVoiceAttachmentExtension("audio/webm;codecs=opus"), ".webm");
  assert.equal(resolveVoiceAttachmentExtension("audio/ogg"), ".ogg");
  assert.equal(resolveVoiceAttachmentExtension("audio/mp4"), ".m4a");
  assert.equal(resolveVoiceAttachmentExtension("audio/mpeg"), ".mp3");
  assert.equal(resolveVoiceAttachmentExtension("audio/wav"), ".wav");
  assert.equal(resolveVoiceAttachmentExtension("application/octet-stream"), ".webm");
});
