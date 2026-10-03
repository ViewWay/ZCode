// OpenAI 兼容生成端点适配器单测（specs/image-tools.md A1、specs/voice-pipeline.md A2）：
// 请求构造（URL 拼接、鉴权头、JSON/multipart 体）与错误归一化（网络/超时/HTTP/
// 响应解析），全部走 fake fetch，不真实联网。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test apps/zcode-cli/packages/adapters/test/generation-endpoints.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createImageGenerationsEndpoint,
  createVoiceSynthesesEndpoint,
  createVoiceTranscriptionsEndpoint,
  isGenerationEndpointError,
  type GenerationEndpointConfig,
} from "../src/generation/index.js";

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

type Responder = (call: RecordedCall, index: number) => Promise<Response> | Response;

function fakeFetch(responder: Responder): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const call: RecordedCall = {
      url: typeof input === "string" ? input : String(input),
      init,
    };
    calls.push(call);
    return responder(call, calls.length - 1);
  };
  return { fetch: fetch as typeof fetch, calls };
}

const BASE_CONFIG: GenerationEndpointConfig = {
  baseUrl: "https://api.example.com/v1/",
  apiKey: "sk-test-123",
  model: "gpt-image-1",
  timeoutMs: 60_000,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readJsonBody(call: RecordedCall): Promise<Record<string, unknown>> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

async function readFormBody(call: RecordedCall): Promise<FormData> {
  return new Request(call.url, { method: "POST", body: call.init?.body }).formData();
}

function headersOf(call: RecordedCall): Record<string, string> {
  const headers: Record<string, string> = {};
  new Headers(call.init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

// ------------------------------------------------------------
// imageGenerations：POST /images/generations
// ------------------------------------------------------------

test("图像生成：URL 拼接（去尾部斜杠）、Bearer 鉴权、JSON 体与 b64 结果", async () => {
  const { fetch, calls } = fakeFetch(() =>
    jsonResponse({ created: 0, data: [{ b64_json: "aGVsbG8=" }] }),
  );
  const result = await createImageGenerationsEndpoint({ ...BASE_CONFIG, fetch }).generateImage({
    prompt: "a cat",
    size: "1024x1024",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.example.com/v1/images/generations");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.equal(headersOf(calls[0]!).authorization, "Bearer sk-test-123");
  assert.equal(headersOf(calls[0]!)["content-type"], "application/json");
  assert.deepEqual(await readJsonBody(calls[0]!), {
    model: "gpt-image-1",
    prompt: "a cat",
    n: 1,
    size: "1024x1024",
  });
  assert.equal(result.dataBase64, "aGVsbG8=");
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.width, 1024);
  assert.equal(result.height, 1024);
});

test("图像生成：provider 自定义头透传，显式 Authorization 优先于 apiKey", async () => {
  const { fetch, calls } = fakeFetch(() => jsonResponse({ data: [{ b64_json: "aGk=" }] }));
  await createImageGenerationsEndpoint({
    ...BASE_CONFIG,
    headers: { "x-gateway": "1", Authorization: "Bearer custom" },
    fetch,
  }).generateImage({ prompt: "p" });

  const headers = headersOf(calls[0]!);
  assert.equal(headers.authorization, "Bearer custom");
  assert.equal(headers["x-gateway"], "1");
});

test("图像生成：URL 模式经同一出口拉取产物并按 Content-Type 定 MIME", async () => {
  const { fetch, calls } = fakeFetch((call, index) =>
    index === 0
      ? jsonResponse({ data: [{ url: "https://cdn.example.com/a.png" }] })
      : new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/webp" },
        }),
  );
  const result = await createImageGenerationsEndpoint({ ...BASE_CONFIG, fetch }).generateImage({
    prompt: "p",
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.url, "https://cdn.example.com/a.png");
  assert.equal(calls[1]!.init?.method, "GET");
  assert.equal(result.mimeType, "image/webp");
  assert.equal(result.dataBase64, Buffer.from([1, 2, 3]).toString("base64"));
});

// ------------------------------------------------------------
// imageGenerations：POST /images/edits（multipart）
// ------------------------------------------------------------

test("图像编辑：multipart 体（model/prompt/size/源图文件名与 MIME）", async () => {
  const { fetch, calls } = fakeFetch(() => jsonResponse({ data: [{ b64_json: "ZWRpdA==" }] }));
  const result = await createImageGenerationsEndpoint({ ...BASE_CONFIG, fetch }).editImage({
    prompt: "darken background",
    imageBase64: Buffer.from("source-bytes").toString("base64"),
    imageMimeType: "image/jpeg",
    size: "512x512",
  });

  assert.equal(calls[0]!.url, "https://api.example.com/v1/images/edits");
  // multipart Content-Type（含 boundary）由 fetch 序列化 FormData 时生成，
  // fake 出口看不到该头；此层断言体是 FormData，字段由 readFormBody 校验。
  assert.ok(calls[0]!.init?.body instanceof FormData);
  const form = await readFormBody(calls[0]!);
  assert.equal(form.get("model"), "gpt-image-1");
  assert.equal(form.get("prompt"), "darken background");
  assert.equal(form.get("size"), "512x512");
  const file = form.get("image");
  assert.ok(file instanceof File);
  assert.equal(file.name, "source.jpg");
  assert.equal(file.type, "image/jpeg");
  assert.equal(
    Buffer.from(await file.arrayBuffer()).toString(),
    "source-bytes",
  );
  assert.equal(result.dataBase64, "ZWRpdA==");
});

test("图像编辑：缺源图字节直接归一化报错，不发起网络请求", async () => {
  const { fetch, calls } = fakeFetch(() => jsonResponse({}));
  await assert.rejects(
    createImageGenerationsEndpoint({ ...BASE_CONFIG, fetch }).editImage({ prompt: "p" }),
    (error: unknown) => isGenerationEndpointError(error) && error.kind === "invalid-response",
  );
  assert.equal(calls.length, 0);
});

// ------------------------------------------------------------
// voiceTranscriptions：POST /audio/transcriptions（multipart）
// ------------------------------------------------------------

test("语音转写：multipart（file/model/language）与 duration 秒→毫秒", async () => {
  const { fetch, calls } = fakeFetch(() =>
    jsonResponse({ text: "你好", duration: 1.5, language: "zh" }),
  );
  const result = await createVoiceTranscriptionsEndpoint({
    ...BASE_CONFIG,
    model: "whisper-1",
    fetch,
  }).transcribe({
    audioBase64: Buffer.from("audio-bytes").toString("base64"),
    audioMimeType: "audio/mpeg",
    language: "zh",
  });

  assert.equal(calls[0]!.url, "https://api.example.com/v1/audio/transcriptions");
  assert.ok(calls[0]!.init?.body instanceof FormData);
  const form = await readFormBody(calls[0]!);
  assert.equal(form.get("model"), "whisper-1");
  assert.equal(form.get("language"), "zh");
  const file = form.get("file");
  assert.ok(file instanceof File);
  assert.equal(file.name, "audio.mp3");
  assert.equal(file.type, "audio/mpeg");
  assert.equal(result.text, "你好");
  assert.equal(result.durationMs, 1500);
  assert.equal(result.language, "zh");
});

test("语音转写：响应缺 text 字段归一化为 invalid-response", async () => {
  const { fetch } = fakeFetch(() => jsonResponse({ duration: 2 }));
  await assert.rejects(
    createVoiceTranscriptionsEndpoint({ ...BASE_CONFIG, fetch }).transcribe({
      audioBase64: "aGk=",
    }),
    (error: unknown) => isGenerationEndpointError(error) && error.kind === "invalid-response",
  );
});

// ------------------------------------------------------------
// voiceSyntheses：POST /audio/speech（JSON）
// ------------------------------------------------------------

test("语音合成：JSON 体（model/input/voice 可选）与音频字节结果", async () => {
  const { fetch, calls } = fakeFetch(() =>
    new Response(new Uint8Array([9, 9]), {
      status: 200,
      headers: { "content-type": "audio/wav" },
    }),
  );
  const result = await createVoiceSynthesesEndpoint({
    ...BASE_CONFIG,
    model: "tts-1",
    fetch,
  }).synthesize({ text: "读出来", voice: "alloy" });

  assert.equal(calls[0]!.url, "https://api.example.com/v1/audio/speech");
  assert.deepEqual(await readJsonBody(calls[0]!), {
    model: "tts-1",
    input: "读出来",
    voice: "alloy",
  });
  assert.equal(result.mimeType, "audio/wav");
  assert.equal(result.audioBase64, Buffer.from([9, 9]).toString("base64"));
});

test("语音合成：缺 voice 时省略字段；Content-Type 缺省 audio/mpeg", async () => {
  const { fetch, calls } = fakeFetch(() => new Response(new Uint8Array([1])));
  const result = await createVoiceSynthesesEndpoint({
    ...BASE_CONFIG,
    model: "tts-1",
    fetch,
  }).synthesize({ text: "hello" });

  assert.deepEqual(await readJsonBody(calls[0]!), { model: "tts-1", input: "hello" });
  assert.equal(result.mimeType, "audio/mpeg");
});

test("语音合成：200 + JSON 视为 invalid-response，不把错误体当音频", async () => {
  const { fetch } = fakeFetch(() => jsonResponse({ error: "quota" }));
  await assert.rejects(
    createVoiceSynthesesEndpoint({ ...BASE_CONFIG, fetch }).synthesize({ text: "x" }),
    (error: unknown) => isGenerationEndpointError(error) && error.kind === "invalid-response",
  );
});

// ------------------------------------------------------------
// 错误归一化：网络 / 超时 / 4xx / 5xx / 响应解析
// ------------------------------------------------------------

test("网络失败归一化为 network", async () => {
  const { fetch } = fakeFetch(() => {
    throw new Error("fetch failed");
  });
  await assert.rejects(
    createImageGenerationsEndpoint({ ...BASE_CONFIG, fetch }).generateImage({ prompt: "p" }),
    (error: unknown) =>
      isGenerationEndpointError(error) &&
      error.kind === "network" &&
      error.message.includes("生成端点网络请求失败"),
  );
});

test("AbortSignal.timeout 到期（TimeoutError）归一化为 timeout", async () => {
  const { fetch } = fakeFetch(() => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  await assert.rejects(
    createImageGenerationsEndpoint({ ...BASE_CONFIG, fetch }).generateImage({ prompt: "p" }),
    (error: unknown) =>
      isGenerationEndpointError(error) &&
      error.kind === "timeout" &&
      error.message.includes("60000"),
  );
});

test("4xx 携带状态与 provider 错误消息", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse({ error: { message: "Incorrect API key provided" } }, 401),
  );
  await assert.rejects(
    createImageGenerationsEndpoint({ ...BASE_CONFIG, fetch }).generateImage({ prompt: "p" }),
    (error: unknown) =>
      isGenerationEndpointError(error) &&
      error.kind === "http" &&
      error.status === 401 &&
      error.providerMessage === "Incorrect API key provided" &&
      error.message.includes("Incorrect API key provided"),
  );
});

test("5xx 非 JSON 体回退为原始文本消息", async () => {
  const { fetch } = fakeFetch(() => new Response("upstream unavailable", { status: 503 }));
  await assert.rejects(
    createVoiceSynthesesEndpoint({ ...BASE_CONFIG, fetch }).synthesize({ text: "x" }),
    (error: unknown) =>
      isGenerationEndpointError(error) &&
      error.kind === "http" &&
      error.status === 503 &&
      error.providerMessage === "upstream unavailable",
  );
});

test("200 非 JSON 归一化为 invalid-response", async () => {
  const { fetch } = fakeFetch(() => new Response("<html>not json</html>", { status: 200 }));
  await assert.rejects(
    createImageGenerationsEndpoint({ ...BASE_CONFIG, fetch }).generateImage({ prompt: "p" }),
    (error: unknown) => isGenerationEndpointError(error) && error.kind === "invalid-response",
  );
});

test("响应缺 data 条目归一化为 invalid-response", async () => {
  const { fetch } = fakeFetch(() => jsonResponse({ created: 0, data: [] }));
  await assert.rejects(
    createImageGenerationsEndpoint({ ...BASE_CONFIG, fetch }).generateImage({ prompt: "p" }),
    (error: unknown) => isGenerationEndpointError(error) && error.kind === "invalid-response",
  );
});
