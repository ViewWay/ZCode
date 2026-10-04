// ============================================================
// OpenAI 兼容生成端点共享层 - 统一出口与错误归一化
// ============================================================
// specs/image-tools.md、specs/voice-pipeline.md：图像生成/编辑与语音转写/合成
// 的 OpenAI 兼容端点调用共用本层。网络出口复用模型 provider 同一代理感知
// fetch（createNetworkProxyFetch），不散落裸 fetch；网络/超时/HTTP 状态/响应
// 解析四类失败归一为 GenerationEndpointError，供上层映射为可读工具失败。

import { createNetworkProxyFetch } from "../network/proxy-fetch.js";

export type GenerationEndpointFetch = typeof globalThis.fetch;

// 不导出：adapters 已有 model-execution 的 EnvRecord 公共名，重复导出会让
// 根 index 的 * 再导出产生歧义；本模块内部用结构类型即可。
type EnvRecord = Record<string, string | undefined>;

/** base64 → 独立缓冲的字节副本（Blob 构造要求 ArrayBuffer 背书的视图）。 */
export function base64ToEndpointBytes(value: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(value, "base64");
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes;
}

/** 与 AiSdkNetworkConfig 对齐的网络出口策略（代理与自定义 CA）。 */
export interface GenerationEndpointNetworkConfig {
  caCertFile?: string;
  env?: EnvRecord;
  httpProxy?: string;
  noProxy?: string;
}

/**
 * 单个生成端点的调用配置。baseUrl/apiKey/headers/model 均来自 provider
 * 注册表中的模型条目（能力扫描解析），本层不持有任何凭据存放处。
 */
export interface GenerationEndpointConfig {
  baseUrl: string;
  apiKey?: string;
  /** provider 条目自带的自定义请求头（网关鉴权等）；显式 Authorization 优先于 apiKey。 */
  headers?: Record<string, string>;
  model: string;
  /** 端点调用超时；由 bootstrap seam 传入 core handler 常量，不在本层另设默认。 */
  timeoutMs: number;
  network?: GenerationEndpointNetworkConfig;
  /** 宿主注入出口（测试）；缺省按 network 策略经代理感知 fetch 发送。 */
  fetch?: GenerationEndpointFetch;
}

export type GenerationEndpointErrorKind = "network" | "timeout" | "http" | "invalid-response";

export class GenerationEndpointError extends Error {
  readonly kind: GenerationEndpointErrorKind;
  readonly status?: number;
  /** 端点错误体里解析出的原始消息（可读错误的一部分，不用于流程判断）。 */
  readonly providerMessage?: string;
  readonly url?: string;

  constructor(options: {
    kind: GenerationEndpointErrorKind;
    message: string;
    status?: number;
    providerMessage?: string;
    url?: string;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "GenerationEndpointError";
    this.kind = options.kind;
    this.status = options.status;
    this.providerMessage = options.providerMessage;
    this.url = options.url;
  }
}

export function isGenerationEndpointError(error: unknown): error is GenerationEndpointError {
  return error instanceof GenerationEndpointError;
}

/** 错误体读取上限：只需提取可读消息，不把超大响应整段读入。 */
const MAX_ERROR_BODY_CHARS = 64_000;
const AUTHORIZATION_HEADER_NAME = "Authorization";

export interface GenerationEndpointCall {
  /** 相对 baseUrl 的路径（如 "images/generations"）。 */
  path: string;
  method?: "GET" | "POST";
  /** JSON 请求体；与 formData 二选一。 */
  body?: Record<string, unknown>;
  /** multipart 请求体；与 body 二选一。 */
  formData?: FormData;
}

/**
 * 发起一次端点调用并归一化失败。成功（2xx）时返回原始 Response，响应体
 * 的形态（JSON/二进制）由各端点模块自行解析。
 */
export async function callGenerationEndpoint(
  config: GenerationEndpointConfig,
  call: GenerationEndpointCall,
): Promise<Response> {
  const url = joinEndpointUrl(config.baseUrl, call.path);
  const headers = buildEndpointHeaders(config);
  const method = call.method ?? "POST";
  const init: RequestInit = {
    method,
    headers,
    ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
    ...(call.formData !== undefined ? { body: call.formData } : {}),
  };
  if (call.body !== undefined && !hasHeader(headers, "content-type")) {
    headers["content-type"] = "application/json";
  }

  const fetch = config.fetch ?? createNetworkProxyFetch({ ...config.network });
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(config.timeoutMs) });
  } catch (error) {
    throw toEndpointError(error, { url, timeoutMs: config.timeoutMs });
  }

  if (!response.ok) {
    const providerMessage = await readProviderErrorMessage(response);
    const summary = providerMessage ?? response.statusText ?? "";
    const label = response.status >= 500 ? "服务端错误" : "请求被拒绝";
    throw new GenerationEndpointError({
      kind: "http",
      status: response.status,
      providerMessage,
      url,
      message: `生成端点返回 HTTP ${response.status}（${label}）${summary ? `：${summary}` : ""}`,
    });
  }
  return response;
}

/** 解析 JSON 响应体；非法 JSON/非对象归一为 invalid-response。 */
export async function readEndpointJson(response: Response, url: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new GenerationEndpointError({
      kind: "invalid-response",
      url,
      message: "生成端点响应不是合法 JSON",
      cause: error,
    });
  }
}

/** 读取二进制响应体（图像/音频产物）。 */
export async function readEndpointBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

export function joinEndpointUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "");
  return `${trimmed}/${path.replace(/^\/+/u, "")}`;
}

function buildEndpointHeaders(config: GenerationEndpointConfig): Record<string, string> {
  const headers: Record<string, string> = { ...config.headers };
  if (config.apiKey && !hasHeader(headers, AUTHORIZATION_HEADER_NAME)) {
    headers[AUTHORIZATION_HEADER_NAME] = `Bearer ${config.apiKey}`;
  }
  return headers;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalizedName);
}

function toEndpointError(error: unknown, context: { url: string; timeoutMs: number }): Error {
  if (error instanceof GenerationEndpointError) return error;
  // AbortSignal.timeout 到期抛出 name 为 TimeoutError 的 DOMException（Node 18+）。
  if (error instanceof Error && error.name === "TimeoutError") {
    return new GenerationEndpointError({
      kind: "timeout",
      url: context.url,
      message: `生成端点请求超时（${context.timeoutMs}ms）：${context.url}`,
      cause: error,
    });
  }
  return new GenerationEndpointError({
    kind: "network",
    url: context.url,
    message: `生成端点网络请求失败：${error instanceof Error ? error.message : String(error)}`,
    cause: error,
  });
}

/** 从错误体提取可读消息（OpenAI 兼容形态 error.message / error 字符串；非 JSON 取原始文本）。 */
async function readProviderErrorMessage(response: Response): Promise<string | undefined> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  const capped = text.slice(0, MAX_ERROR_BODY_CHARS);
  if (capped.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(capped);
    if (parsed && typeof parsed === "object") {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === "string" && error.length > 0) return error;
      if (error && typeof error === "object") {
        const message = (error as { message?: unknown }).message;
        if (typeof message === "string" && message.length > 0) return message;
      }
      const message = (parsed as { message?: unknown }).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
    return capped;
  } catch {
    // 非 JSON 错误体（网关 HTML/纯文本）：截断后的原始文本就是最好的可读消息。
    return capped;
  }
}
