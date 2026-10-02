// ============================================================
// Image Generation Port - 图像生成/编辑端口本地实现（specs/image-tools.md）
// ============================================================
// CLI 进程内本地装配（provider 配置在同一进程，无需协议转发）。配置驱动：
// 每次调用现读 Provider Registry 视图，扫描首个声明了
// properties.capabilities.image 的模型条目（扫描与组装见 generation-capability.ts），
// 命中后交给 adapters 的 OpenAI 兼容图像端点（/images/generations、
// /images/edits）调用；未命中保持可读未配置错误（spec 验收 3），不发起任何
// 网络请求。超时取 core 的 IMAGE_TOOL_TIMEOUT_MS。

import { createImageGenerationsEndpoint } from "@zcode/adapters/generation";
import { IMAGE_TOOL_TIMEOUT_MS } from "@zcode/core";
import type {
  ImageGenerationPort,
  ImageGenerationRequest,
  ImageGenerationResult,
} from "@zcode/contracts";
import {
  composeGenerationEndpointConfig,
  type LocalGenerationPortDeps,
} from "../generation-capability.js";

/** 未配置能力声明时的可读指引（spec 验收 3）。 */
const IMAGE_ENDPOINT_UNCONFIGURED =
  "图像端点未配置：请在设置中为某个 provider 的模型条目声明图像能力（properties.capabilities.image）后再使用图像工具。";

export function createLocalImageGenerationPort(
  deps: LocalGenerationPortDeps,
): ImageGenerationPort {
  return {
    async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
      const endpoint = createImageGenerationsEndpoint(
        composeGenerationEndpointConfig(deps, "image", IMAGE_ENDPOINT_UNCONFIGURED, IMAGE_TOOL_TIMEOUT_MS),
      );
      return endpoint.generateImage(request);
    },
    async editImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
      const endpoint = createImageGenerationsEndpoint(
        composeGenerationEndpointConfig(deps, "image", IMAGE_ENDPOINT_UNCONFIGURED, IMAGE_TOOL_TIMEOUT_MS),
      );
      return endpoint.editImage(request);
    },
  };
}
