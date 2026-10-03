// A1 语音工具 handler 单测（specs/voice-pipeline.md）
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ASR_TRANSCRIBE_TOOL_NAME,
  AsrTranscribeInputSchema,
  TtsSpeechInputSchema,
  TtsSpeechOutputSchema,
} from "@zcode/contracts";
import { asrTranscribeToolEntry } from "../../src/tool/handlers/asr-transcribe.js";
import { ttsSpeechToolEntry } from "../../src/tool/handlers/tts-speech.js";

function fakeStore(dir: string) {
  let n = 0;
  return {
    writeToolResultBinaryArtifact: async (req: { content: Uint8Array; extension?: string }) => {
      n += 1;
      const p = join(dir, `audio-${n}.${req.extension ?? "bin"}`);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(p, req.content);
      return { id: `a${n}`, uri: p, path: p, bytes: req.content.length, contentType: "audio/mpeg", createdAt: new Date() };
    },
  };
}

function makeContext(port: unknown, store: unknown, extra: Record<string, unknown> = {}) {
  return { toolCallId: "call-1", sessionId: "s-1", traceId: "t-1", voicePipelinePort: port, artifactStore: store, ...extra } as unknown as Parameters<typeof ttsSpeechToolEntry.handler>[1];
}

const DIR = mkdtempSync(join(tmpdir(), "zcode-voice-tools-"));

test("契约：asr/tts 非法入参被 zod 拒绝", () => {
  assert.throws(() => AsrTranscribeInputSchema.parse({}));
  assert.throws(() => TtsSpeechInputSchema.parse({ text: "" }));
});

test("tts_speech：fake 端口合成 → 落盘 artifacts → 输出路径", async () => {
  const store = fakeStore(DIR);
  const context = makeContext(
    { transcribe: async () => ({ text: "" }), synthesize: async () => ({ audioBase64: Buffer.from("RIFF").toString("base64"), mimeType: "audio/mpeg" }) },
    store,
  );
  const output = (await ttsSpeechToolEntry.handler!(
    { text: "把这段总结读出来" },
    context,
  )) as { file: string };
  assert.ok(output.file.endsWith(".mp3"));
});

test("tts_speech：端口缺席 → ConfigurationError（fail-closed 守卫）", async () => {
  const context = makeContext(undefined, fakeStore(DIR));
  await assert.rejects(
    () => ttsSpeechToolEntry.handler!({ text: "x" }, context),
    /VoicePipelinePort is not configured/u,
  );
});

test("asr_transcribe：无 fileSystemPort → ConfigurationError", async () => {
  const context = makeContext(
    { transcribe: async () => ({ text: "ok" }) },
    fakeStore(DIR),
  );
  await assert.rejects(
    () => asrTranscribeToolEntry.handler!({ file: "/ws/a.mp3" }, context),
    /FileSystemPort is not configured/u,
  );
});

test("工具名常量与注册表契约一致", () => {
  assert.equal(typeof ASR_TRANSCRIBE_TOOL_NAME, "string");
  assert.ok(TtsSpeechOutputSchema.safeParse({ file: "/x.mp3" }).success);
});