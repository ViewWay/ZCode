// ============================================================
// Image Generation Port - 图像生成/编辑端口本地实现（specs/image-tools.md）
// ============================================================
// CLI 进程内本地装配（provider 配置在同一进程，无需协议转发）。v1 为配置驱动
// 的占位实现：未配置图像端点时返回可读错误（spec 验收 3），端点默认值与模型名
// 为产品待定项；产品确认后在本文件的 seam 注释处接入 adapters 图像端点调用。

import type {
  ImageGenerationPort,
  ImageGenerationRequest,
  ImageGenerationResult,
} from "@zcode/contracts";

/** v1 端点未配置的可读指引（spec 验收 3）。 */
const IMAGE_ENDPOINT_UNCONFIGURED =
  "图像端点未配置：请在设置中为某个 provider 配置图像模型（默认端点与模型名为产品待定项）。";

/**
 * 端点配置 seam：产品确认默认图像端点/模型后，在此读取 provider 配置并接入
 * adapters 的图像端点调用（@ai-sdk/provider image-model v2/v3 接口已在依赖树）。
 */
export function createLocalImageGenerationPort(): ImageGenerationPort {
  return {
    async generateImage(_request: ImageGenerationRequest): Promise<ImageGenerationResult> {
      throw new Error(IMAGE_ENDPOINT_UNCONFIGURED);
    },
    async editImage(_request: ImageGenerationRequest): Promise<ImageGenerationResult> {
      throw new Error(IMAGE_ENDPOINT_UNCONFIGURED);
    },
  };
}
