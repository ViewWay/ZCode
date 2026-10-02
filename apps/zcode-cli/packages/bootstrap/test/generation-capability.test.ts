// 生成端点能力扫描与本地端口 seam 单测（specs/image-tools.md A1、specs/voice-pipeline.md
// A2）：fake 配置源（Registry 视图）下的首 hit 选择、凭据过滤、独立扫描、未配置
// 可读错误与现读视图（不缓存快照）。端口实现经注入 fake fetch 验证请求目标，
// 不真实联网。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test apps/zcode-cli/packages/bootstrap/test/generation-capability.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Provider } from "@zcode/provider";
import type { ProviderRegistryModelSource } from "../src/app/provider-registry-model-runtime.js";
import {
  composeGenerationEndpointConfig,
  selectGenerationCapabilityEndpoint,
  type GenerationEndpointSelection,
} from "../src/generation-capability.js";
import { createLocalImageGenerationPort } from "../src/image-generation/image-generation-port.js";
import { createLocalVoicePipelinePort } from "../src/voice-pipeline/voice-pipeline-port.js";

interface FakeModelInput {
  modelId: string;
  capabilities?: { image?: boolean; transcription?: boolean; speech?: boolean };
}

interface FakeProviderInput {
  providerId: string;
  baseUrl?: string;
  apiKey?: string | null;
  accessType?: "api-key" | "zhipu-account";
  headers?: Record<string, string>;
  models: FakeModelInput[];
}

/** 只填扫描路径触达的字段，其余经 unknown 断言为 Provider（fake 配置源）。 */
function fakeProvider(input: FakeProviderInput): Provider {
  return {
    providerId: input.providerId,
    providerName: null,
    templateId: null,
    config: {
      group: "standard-personal",
      access:
        input.accessType === "zhipu-account"
          ? { type: "zhipu-account", accountType: "zai", mode: "start-plan", entitled: true }
          : { type: "api-key", apiKey: input.apiKey ?? null },
      api: {
        type: "openai-chat-completions",
        baseUrl: input.baseUrl ?? "https://api.example.com/v1",
        ...(input.headers ? { headers: input.headers } : {}),
      },
    },
    models: input.models.map((model) => ({
      modelId: model.modelId,
      config: {
        enabled: true,
        properties: { ...(model.capabilities ? { capabilities: model.capabilities } : {}) },
        optionSpecs: {},
      },
    })),
  } as unknown as Provider;
}

function fakeRegistry(providers: Provider[]): ProviderRegistryModelSource {
  return {
    getView: () => ({ revision: 1, providers }),
    getProvider: () => undefined,
    getModel: () => undefined,
    validateSelection: () => ({ ok: true }),
    onDidChange: () => () => undefined,
  };
}

// ------------------------------------------------------------
// selectGenerationCapabilityEndpoint：纯函数扫描
// ------------------------------------------------------------

test("扫描取首个声明能力的条目，跳过未声明的模型", () => {
  const providers = [
    fakeProvider({
      providerId: "p1",
      apiKey: "sk-1",
      models: [{ modelId: "chat-a" }, { modelId: "img-a", capabilities: { image: true } }],
    }),
    fakeProvider({
      providerId: "p2",
      apiKey: "sk-2",
      models: [{ modelId: "img-b", capabilities: { image: true } }],
    }),
  ];
  const selection = selectGenerationCapabilityEndpoint(providers, "image");
  assert.equal(selection?.providerId, "p1");
  assert.equal(selection?.modelId, "img-a");
  assert.equal(selection?.apiKey, "sk-1");
});

test("账号型 provider 与空凭据被跳过（无 Bearer 可用）", () => {
  const providers = [
    fakeProvider({
      providerId: "account",
      accessType: "zhipu-account",
      models: [{ modelId: "img", capabilities: { image: true } }],
    }),
    fakeProvider({
      providerId: "empty",
      apiKey: "  ",
      models: [{ modelId: "img", capabilities: { image: true } }],
    }),
    fakeProvider({
      providerId: "usable",
      apiKey: "sk-ok",
      models: [{ modelId: "img", capabilities: { image: true } }],
    }),
  ];
  const selection = selectGenerationCapabilityEndpoint(providers, "image");
  assert.equal(selection?.providerId, "usable");
});

test("transcription 与 speech 独立命中各自模型；无声明返回 undefined", () => {
  const providers = [
    fakeProvider({
      providerId: "p1",
      apiKey: "sk-1",
      models: [
        { modelId: "whisper-1", capabilities: { transcription: true } },
        { modelId: "tts-1", capabilities: { speech: true } },
      ],
    }),
  ];
  assert.equal(selectGenerationCapabilityEndpoint(providers, "transcription")?.modelId, "whisper-1");
  assert.equal(selectGenerationCapabilityEndpoint(providers, "speech")?.modelId, "tts-1");
  assert.equal(selectGenerationCapabilityEndpoint(providers, "image"), undefined);
});

test("provider 自定义 headers 随选择透传", () => {
  const providers = [
    fakeProvider({
      providerId: "p1",
      apiKey: "sk-1",
      headers: { "x-gateway": "1" },
      models: [{ modelId: "img", capabilities: { image: true } }],
    }),
  ];
  const selection: GenerationEndpointSelection | undefined =
    selectGenerationCapabilityEndpoint(providers, "image");
  assert.deepEqual(selection?.headers, { "x-gateway": "1" });
});

// ------------------------------------------------------------
// composeGenerationEndpointConfig：seam 组装
// ------------------------------------------------------------

test("compose 组装完整端点配置（超时常量与出口注入）", () => {
  const registry = fakeRegistry([
    fakeProvider({
      providerId: "p1",
      apiKey: "sk-1",
      models: [{ modelId: "img", capabilities: { image: true } }],
    }),
  ]);
  const config = composeGenerationEndpointConfig(
    { registry, network: { httpProxy: "http://127.0.0.1:7890" }, fetch: () => new Response() },
    "image",
    "未配置消息",
    123,
  );
  assert.equal(config.baseUrl, "https://api.example.com/v1");
  assert.equal(config.apiKey, "sk-1");
  assert.equal(config.model, "img");
  assert.equal(config.timeoutMs, 123);
  assert.equal(config.network?.httpProxy, "http://127.0.0.1:7890");
  assert.equal(typeof config.fetch, "function");
});

test("compose 未命中时抛可读错误（不触网）", () => {
  const registry = fakeRegistry([fakeProvider({ providerId: "p1", apiKey: "sk-1", models: [{ modelId: "chat" }] })]);
  assert.throws(
    () => composeGenerationEndpointConfig({ registry }, "image", "图像端点未配置：请声明能力", 123),
    /图像端点未配置：请声明能力/,
  );
});

// ------------------------------------------------------------
// 本地端口：图像 seam
// ------------------------------------------------------------

test("图像端口：命中能力后按 provider 凭据调用 /images/generations", async () => {
  const requests: { url: string; headers: Headers }[] = [];
  const deps = {
    registry: fakeRegistry([
      fakeProvider({
        providerId: "p1",
        apiKey: "sk-img",
        models: [{ modelId: "gpt-image-1", capabilities: { image: true } }],
      }),
    ]),
    fetch: (async (input: unknown, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
      });
      return new Response(JSON.stringify({ data: [{ b64_json: "aGk=" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  };
  const port = createLocalImageGenerationPort(deps);
  const result = await port.generateImage({ prompt: "a cat" });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "https://api.example.com/v1/images/generations");
  assert.equal(requests[0]!.headers.get("authorization"), "Bearer sk-img");
  assert.equal(result.dataBase64, "aGk=");
});

test("图像端口：无能力声明时抛可读未配置错误且零网络请求", async () => {
  let fetchCalls = 0;
  const port = createLocalImageGenerationPort({
    registry: fakeRegistry([fakeProvider({ providerId: "p1", apiKey: "sk-1", models: [{ modelId: "chat" }] })]),
    fetch: (async () => {
      fetchCalls += 1;
      return new Response("{}");
    }) as typeof fetch,
  });
  await assert.rejects(port.generateImage({ prompt: "p" }), /图像端点未配置/);
  await assert.rejects(port.editImage({ prompt: "p", imageBase64: "aGk=" }), /图像端点未配置/);
  assert.equal(fetchCalls, 0);
});

// ------------------------------------------------------------
// 本地端口：语音 seam（transcription / speech 独立扫描）
// ------------------------------------------------------------

test("语音端口：transcribe 与 synthesize 各自命中声明模型", async () => {
  const bodies: { url: string; body: unknown }[] = [];
  const deps = {
    registry: fakeRegistry([
      fakeProvider({
        providerId: "p1",
        apiKey: "sk-voice",
        models: [
          { modelId: "whisper-1", capabilities: { transcription: true } },
          { modelId: "tts-1", capabilities: { speech: true } },
        ],
      }),
    ]),
    fetch: (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      bodies.push({ url, body: init?.body });
      if (url.endsWith("/audio/transcriptions")) {
        return new Response(JSON.stringify({ text: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    }) as typeof fetch,
  };
  const port = createLocalVoicePipelinePort(deps);

  const transcription = await port.transcribe({ audioBase64: "aGk=", audioMimeType: "audio/mpeg" });
  assert.equal(transcription.text, "ok");
  // multipart 体断言模型字段：转写必须打 whisper-1。
  const transcriptionForm = await new Request("https://x", {
    method: "POST",
    body: bodies.find((item) => item.url.endsWith("/audio/transcriptions"))!.body as BodyInit,
  }).formData();
  assert.equal(transcriptionForm.get("model"), "whisper-1");

  const synthesis = await port.synthesize({ text: "读出来" });
  assert.equal(synthesis.mimeType, "audio/mpeg");
  const speechBody = JSON.parse(
    String(bodies.find((item) => item.url.endsWith("/audio/speech"))!.body),
  ) as { model: string };
  assert.equal(speechBody.model, "tts-1");
});

test("语音端口：两端点未配置时各自抛可读错误且零网络请求", async () => {
  let fetchCalls = 0;
  const port = createLocalVoicePipelinePort({
    registry: fakeRegistry([]),
    fetch: (async () => {
      fetchCalls += 1;
      return new Response("{}");
    }) as typeof fetch,
  });
  await assert.rejects(port.transcribe({ audioBase64: "aGk=" }), /语音转写端点未配置/);
  await assert.rejects(port.synthesize({ text: "x" }), /语音合成端点未配置/);
  assert.equal(fetchCalls, 0);
});

// ------------------------------------------------------------
// 现读视图：删除能力声明后下一次调用立即回到未配置错误
// ------------------------------------------------------------

test("端口每次调用现读 Registry 视图，不缓存构造期快照", async () => {
  const configured = fakeProvider({
    providerId: "p1",
    apiKey: "sk-1",
    models: [{ modelId: "img", capabilities: { image: true } }],
  });
  let providers: Provider[] = [];
  const registry: ProviderRegistryModelSource = {
    getView: () => ({ revision: 1, providers }),
    getProvider: () => undefined,
    getModel: () => undefined,
    validateSelection: () => ({ ok: true }),
    onDidChange: () => () => undefined,
  };
  const port = createLocalImageGenerationPort({
    registry,
    fetch: (async () =>
      new Response(JSON.stringify({ data: [{ b64_json: "aGk=" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });

  await assert.rejects(port.generateImage({ prompt: "p" }), /图像端点未配置/);
  providers = [configured];
  const result = await port.generateImage({ prompt: "p" });
  assert.equal(result.dataBase64, "aGk=");
  providers = [];
  await assert.rejects(port.generateImage({ prompt: "p" }), /图像端点未配置/);
});
