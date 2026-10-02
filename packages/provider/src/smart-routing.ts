// ============================================================
// Smart 模式 —— 虚拟模型条目的本地路由（参考 MiMo smart-routing 通道体验）
// ============================================================
//
// 用户只选一个 "Smart" 模型选择器入口，解析期在已配置 provider 目录里择优：
// 上下文窗口最大者优先，平手取目录顺序第一。账号类 provider 的可用性
// 由既有解析流程继续校验，这里只负责目录内择优。

import type { ModelSelection } from "@zcode/shared/model-selection";
import type { ProviderRegistryView } from "./registry.js";

export const SMART_PROVIDER_ID = "smart";
export const SMART_MODEL_ID = "auto";

/** Smart 虚拟选择的固定形状；其余选择不参与路由。 */
export function isSmartModelSelection(
  selection: ModelSelection | null | undefined,
): selection is ModelSelection {
  return selection?.providerId === SMART_PROVIDER_ID && selection?.modelId === SMART_MODEL_ID;
}

/** 防御性读取可选属性；缺失/非数值按 0 分。 */
function smartModelScore(model: { config: unknown }): number {
  const properties = (model.config as { properties?: { contextWindow?: unknown } | null })
    ?.properties;
  const contextWindow =
    typeof properties?.contextWindow === "number" && properties.contextWindow > 0
      ? properties.contextWindow
      : 0;
  return contextWindow;
}

/**
 * 在目录里为 Smart 择优：非隐藏 provider 的全部模型中取上下文窗口最大者，
 * 平手保持目录顺序。无候选返回 undefined（调用方映射为 provider-not-found）。
 */
export function resolveSmartRoute(
  registry: ProviderRegistryView,
): ModelSelection | undefined {
  let best: { providerId: string; modelId: string; score: number } | undefined;
  for (const provider of registry.providers) {
    if (provider.config.visibility === "hidden") continue;
    for (const model of provider.models) {
      const score = smartModelScore(model);
      if (best === undefined || score > best.score) {
        best = { providerId: provider.providerId, modelId: model.modelId, score };
      }
    }
  }
  return best === undefined
    ? undefined
    : { providerId: best.providerId, modelId: best.modelId };
}
