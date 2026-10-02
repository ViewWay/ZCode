// ============================================================
// 生成端点能力扫描 - Registry 视图 → 端点调用事实（A1/A2 共用）
// ============================================================
// specs/image-tools.md、specs/voice-pipeline.md：图像/语音端口每次调用现读
// Registry 视图，按注册表顺序取首个声明了对应能力且凭据可用的模型条目。
// 本模块是纯函数（fake 配置源可测）；I/O 与出口策略留在各端口装配处。
// 刻意不缓存快照——与 model-catalog-port 同一条纪律：构造期冻结的目录会让
// 用户删掉配置后仍对着不存在的端点发请求。

import type { GenerationEndpointConfig, GenerationEndpointFetch } from "@zcode/adapters/generation";
import type { Provider } from "@zcode/provider";
import type { ProviderRegistryModelSource } from "./app/provider-registry-model-runtime.js";

/** 能力叶子与模型条目 properties.capabilities 一一对应。 */
export type GenerationCapability = "image" | "transcription" | "speech";

/** 扫描命中的端点事实；凭据来自 provider 条目，不新增存放处。 */
export interface GenerationEndpointSelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly headers?: Record<string, string>;
}

/**
 * 扫描首个声明了 `capability` 且可用的模型条目。跳过账号型（zhipu-account，
 * 无 Bearer 凭据）与凭据缺失的 provider——OpenAI 兼容生成端点只认 API Key。
 */
export function selectGenerationCapabilityEndpoint(
  providers: readonly Provider[],
  capability: GenerationCapability,
): GenerationEndpointSelection | undefined {
  for (const provider of providers) {
    const access = provider.config.access;
    // Registry 是 complete 校验后的视图，key 型 access 的 apiKey 必为非空串；
    // 仍按运行时事实判空，避免空串 Bearer 头。
    const apiKey = access.type === "zhipu-account" ? undefined : access.apiKey?.trim();
    if (!apiKey) continue;
    for (const model of provider.models) {
      if (model.config.properties.capabilities?.[capability] !== true) continue;
      const headers = provider.config.api.headers;
      return {
        providerId: provider.providerId,
        modelId: model.modelId,
        baseUrl: provider.config.api.baseUrl,
        apiKey,
        ...(headers ? { headers: { ...headers } } : {}),
      };
    }
  }
  return undefined;
}

/** 图像/语音两个本地端口共用的装配依赖。 */
export interface LocalGenerationPortDeps {
  /** 进程的 Provider Registry；每次调用现读视图，不缓存快照。 */
  readonly registry: ProviderRegistryModelSource;
  /** 网络出口策略（代理与自定义 CA），与模型 provider 出口同源。 */
  readonly network?: GenerationEndpointConfig["network"];
  /** 宿主注入出口（测试用）；缺省经 createNetworkProxyFetch 代理感知发送。 */
  readonly fetch?: GenerationEndpointFetch;
}

/**
 * 现读 Registry 视图扫描能力声明，组装成 adapters 生成端点的完整调用配置。
 * 未命中时抛 `unconfiguredMessage`（可读错误，不发起任何网络请求）；
 * `timeoutMs` 由调用方取 core handler 常量，两个端口不许各写一个数。
 */
export function composeGenerationEndpointConfig(
  deps: LocalGenerationPortDeps,
  capability: GenerationCapability,
  unconfiguredMessage: string,
  timeoutMs: number,
): GenerationEndpointConfig {
  const selection = selectGenerationCapabilityEndpoint(
    deps.registry.getView().providers,
    capability,
  );
  if (selection === undefined) throw new Error(unconfiguredMessage);
  return {
    baseUrl: selection.baseUrl,
    apiKey: selection.apiKey,
    ...(selection.headers ? { headers: selection.headers } : {}),
    model: selection.modelId,
    timeoutMs,
    ...(deps.network ? { network: deps.network } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };
}
