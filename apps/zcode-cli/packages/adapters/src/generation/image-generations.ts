// ============================================================
// OpenAI 兼容图像生成/编辑端点（specs/image-tools.md A1）
// ============================================================
// 生成 POST {baseUrl}/images/generations（JSON）；编辑 POST {baseUrl}/images/edits
// （multipart）。不做 /chat/completions 视觉回退。响应优先取 data[0].b64_json；
// 端点仅返回 url 时（dall-e 系与部分网关的默认模式）经同一出口拉取字节后转
// base64——否则工具拿不到字节、无法落盘 artifacts。

import type { ImageGenerationRequest, ImageGenerationResult } from "@zcode/contracts";
import {
  base64ToEndpointBytes,
  callGenerationEndpoint,
  GenerationEndpointError,
  type GenerationEndpointConfig,
  type GenerationEndpointFetch,
  joinEndpointUrl,
  readEndpointBytes,
  readEndpointJson,
} from "./endpoint-shared.js";

export interface ImageGenerationsEndpoint {
  generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
  editImage(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
}

const IMAGE_GENERATIONS_PATH = "images/generations";
const IMAGE_EDITS_PATH = "images/edits";
/** OpenAI 兼容图像端点的 JSON 响应不带 MIME 信息；gpt-image-1 默认 PNG。 */
const DEFAULT_IMAGE_MIME_TYPE = "image/png";

export function createImageGenerationsEndpoint(
  config: GenerationEndpointConfig,
): ImageGenerationsEndpoint {
  return {
    async generateImage(request) {
      const url = joinEndpointUrl(config.baseUrl, IMAGE_GENERATIONS_PATH);
      const response = await callGenerationEndpoint(config, {
        path: IMAGE_GENERATIONS_PATH,
        body: {
          model: config.model,
          prompt: request.prompt,
          n: 1,
          ...(request.size ? { size: request.size } : {}),
        },
      });
      return readImageResult(config, response, request.size, url);
    },

    async editImage(request) {
      if (request.imageBase64 === undefined) {
        throw new GenerationEndpointError({
          kind: "invalid-response",
          message: "image_edit 缺少源图字节，无法构造编辑请求",
        });
      }
      const url = joinEndpointUrl(config.baseUrl, IMAGE_EDITS_PATH);
      const mimeType = request.imageMimeType ?? DEFAULT_IMAGE_MIME_TYPE;
      const form = new FormData();
      form.set("model", config.model);
      form.set("prompt", request.prompt);
      form.set(
        "image",
        new Blob([base64ToEndpointBytes(request.imageBase64)], { type: mimeType }),
        filenameForMimeType(mimeType),
      );
      if (request.size) form.set("size", request.size);
      const response = await callGenerationEndpoint(config, {
        path: IMAGE_EDITS_PATH,
        formData: form,
      });
      return readImageResult(config, response, request.size, url);
    },
  };
}

interface ImagesEndpointPayload {
  data?: readonly {
    b64_json?: unknown;
    url?: unknown;
  }[];
}

async function readImageResult(
  config: GenerationEndpointConfig,
  response: Response,
  size: string | undefined,
  requestUrl: string,
): Promise<ImageGenerationResult> {
  const payload = (await readEndpointJson(response, requestUrl)) as ImagesEndpointPayload;
  const first = Array.isArray(payload?.data) ? payload.data[0] : undefined;
  if (!first) {
    throw new GenerationEndpointError({
      kind: "invalid-response",
      url: requestUrl,
      message: "生成端点响应缺少 data[0] 图像条目",
    });
  }
  if (typeof first.b64_json === "string" && first.b64_json.length > 0) {
    const { width, height } = parseSize(size);
    return {
      dataBase64: first.b64_json,
      mimeType: DEFAULT_IMAGE_MIME_TYPE,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    };
  }
  if (typeof first.url === "string" && first.url.length > 0) {
    // URL 模式：经同一出口拉取产物字节，超时与错误归一复用端点调用。
    const downloaded = await downloadImageBytes(config, first.url);
    const { width, height } = parseSize(size);
    return {
      dataBase64: bytesToBase64(downloaded.bytes),
      mimeType: downloaded.mimeType ?? DEFAULT_IMAGE_MIME_TYPE,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    };
  }
  throw new GenerationEndpointError({
    kind: "invalid-response",
    url: requestUrl,
    message: "生成端点响应既无 b64_json 也无 url，无法取得图像字节",
  });
}

async function downloadImageBytes(
  config: GenerationEndpointConfig,
  imageUrl: string,
): Promise<{ bytes: Uint8Array; mimeType?: string }> {
  const fetch = resolveEndpointFetch(config);
  let response: Response;
  try {
    response = await fetch(imageUrl, {
      method: "GET",
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch {
    // 产物 URL 下载失败按网络错误归类；具体原因不区分，错误消息带 URL 便于定位。
    throw new GenerationEndpointError({
      kind: "network",
      url: imageUrl,
      message: `图像产物下载失败：${imageUrl}`,
    });
  }
  if (!response.ok) {
    throw new GenerationEndpointError({
      kind: "http",
      status: response.status,
      url: imageUrl,
      message: `图像产物下载返回 HTTP ${response.status}：${imageUrl}`,
    });
  }
  const contentType = response.headers.get("content-type");
  const mimeType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return {
    bytes: await readEndpointBytes(response),
    // URL 模式的产物无 JSON 元数据，只能依赖响应 Content-Type。
    ...(mimeType && mimeType.startsWith("image/") ? { mimeType } : {}),
  };
}

function resolveEndpointFetch(config: GenerationEndpointConfig): GenerationEndpointFetch {
  return config.fetch ?? globalThis.fetch.bind(globalThis);
}

/** "1024x1024" → {1024,1024}；解析失败（或端点自定义尺寸串）返回空对象。 */
function parseSize(size: string | undefined): { width?: number; height?: number } {
  if (size === undefined) return {};
  const match = /^(\d+)\s*[xX×]\s*(\d+)$/u.exec(size.trim());
  if (!match) return {};
  return { width: Number(match[1]), height: Number(match[2]) };
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function filenameForMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg") return "source.jpg";
  if (mimeType === "image/webp") return "source.webp";
  if (mimeType === "image/gif") return "source.gif";
  return "source.png";
}
