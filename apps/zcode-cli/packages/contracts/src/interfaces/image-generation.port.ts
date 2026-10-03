// ============================================================
// Image Generation Port - 图像生成/编辑能力端口（specs/image-tools.md）
// ============================================================
// image_gen / image_edit 的执行端口，与 SessionChatPort/DesktopSettingsPort 同族：
// 宿主（bootstrap，CLI 进程内本地装配）提供实现。v1 为配置驱动的占位实现：
// 未配置图像端点时返回可读结构化错误（spec 验收场景 3），端点默认值与模型名
// 属产品待定项；端口实现预留 config seam，产品确认后只需补 adapters 侧调用。
// 端口缺席时 core 不注册工具（fail-closed，runtime-tools 按 includeImageTools 门控）。

/**
 * 图像生成/编辑结果：字节以 base64 交付，落盘经 ToolArtifactStorePort 写会话 artifacts
 * （唯一落盘点），handler 回路径与尺寸。
 */
export interface ImageGenerationResult {
  dataBase64: string;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface ImageGenerationRequest {
  /** 生成提示词；编辑时为编辑指令。 */
  prompt: string;
  /** 编辑模式的源图（原始字节 base64）。 */
  imageBase64?: string;
  /** 源图 MIME 类型。 */
  imageMimeType?: string;
  /** 端点侧尺寸参数（如 "1024x1024"）；未配置时由端点默认。 */
  size?: string;
}

/**
 * 图像生成/编辑端口。实现方自行兜底：不可用时抛带可读 message 的 Error
 * （core 映射为工具失败，recoverable），不允许未归类错误阻断 turn。
 */
export interface ImageGenerationPort {
  generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
  editImage(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
}
