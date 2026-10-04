// Smart 决策 v4 config 投影（specs/smart-routing-v3.md B3 UI 消费面）。
// 纯函数模块：把 ModelSelectedPayload.smartRouting 的有无裁决为 config.smartRouting 的
// 下一值与是否变化；供 product-projection 的 onModelSelected 接线，可独立单测。
import type { ModelSelectedPayload } from "@zcode/contracts";
import {
  sameSmartRoutingDecision,
  type SmartRoutingDecision,
} from "@zcode/shared/zcode-protocol-v4";

export interface SmartRoutingConfigResolution {
  /** config.smartRouting 的下一值；null 表示清除（键级整体替换语义下显式落 undefined）。 */
  next: SmartRoutingDecision | null;
  /** 与上一值的相等性裁决；true 时 onModelSelected 才把 smartRouting 计入 config patch。 */
  changed: boolean;
}

/**
 * Smart 决策 config 投影裁决。
 *
 * 规则（specs/smart-routing-v3.md）：
 * - hydration 合成事件只从 message 事实重建历史选型，不是权威选型动作，不触碰 Smart 决策面；
 * - 事件带 smartRouting → 设为当前档位决策（Smart 换档时刻，wire 契约见 cf5becf）；
 * - 事件不带 → 清除（非 Smart 换档：显式切换等；Smart 换档事件必带该字段）；
 * - 与上一值相同（同档位重复事件）→ 无变化，不进 patch。
 */
export function resolveSmartRoutingConfigValue(options: {
  previous: SmartRoutingDecision | null;
  payloadSmartRouting: ModelSelectedPayload["smartRouting"];
  /** 当前事件是否为冷恢复合成的 hydration 事件（HYDRATION_TRACE_ID）。 */
  isHydration: boolean;
}): SmartRoutingConfigResolution {
  if (options.isHydration) {
    // hydration 合成事件不触碰决策面：保持上一值、判无变化。
    return { next: options.previous, changed: false };
  }
  const next = options.payloadSmartRouting
    ? { tier: options.payloadSmartRouting.tier, note: options.payloadSmartRouting.note }
    : null;
  return { next, changed: !sameSmartRoutingDecision(options.previous, next) };
}
