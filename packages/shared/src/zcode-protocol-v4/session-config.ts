import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";

// ── config──
export const sessionConfigStateSchema = z.object({
  /** Session 接受并持久化的稀疏选择意图；provider/model/thought 仅为 UI effective 投影。 */
  modelSelection: modelSelectionSchema.optional(),
  provider: z.string(),
  model: z.string(),
  thought: z.string(),
  // 思考档位是当前模型的能力，不是 workspace/UI 偏好。
  // default 仅用于兼容旧快照；新 agent 必须从 runtime 投影实际集合。
  thoughtLevels: z.array(z.string()).default([]),
  followupMode: z.enum(["queue", "guide"]),
  // additive（冻结面演进，同 meta 的裁决口径）：agent 协作模式（core CollaborationMode）。
  // 必须带 default 才不破坏旧快照/旧发送端的解析；投影经 SessionModeChanged 事件更新。
  mode: z.string().default("build"),
  planEnabled: z.boolean().optional(),
  /** 明确审批结果；草稿按 interactionId 消费一次，普通 mode 更新不重置它。 */
  permissionGrant: z.object({ interactionId: z.string().min(1) }).optional(),
  /**
   * Smart 路由决策面（specs/smart-routing-v3.md B3 UI 消费面）：当前生效档位与最近一次
   * 切换原因。只随 Smart 换档的 ModelSelected 事件出现；非 Smart 换档（显式切换）不带
   * 该字段，投影按「事件不带 → 清除」裁决。缺失字段兼容旧快照。
   */
  smartRouting: z
    .object({
      tier: z.enum(["pro", "flash"]),
      note: z.string(),
    })
    .optional(),
  /** 最近工具转换的关联，供草稿定向同步；不新增可见历史事件。 */
  planTransition: z
    .object({
      toolCallId: z.string(),
      planEnabled: z.boolean(),
    })
    .optional(),
});
export type SessionConfigState = z.infer<typeof sessionConfigStateSchema>;

export const sessionModelTransitionSchema = z.object({
  eventId: z.string().min(1),
  origin: z.literal("registryFallback"),
  from: z.object({
    provider: z.string(),
    model: z.string(),
  }),
  to: z.object({
    provider: z.string(),
    model: z.string(),
  }),
});
export type SessionModelTransition = z.infer<typeof sessionModelTransitionSchema>;

/** Smart 决策档位与原因的值类型（`sessionConfigStateSchema.smartRouting` 的非空形态）。 */
export type SmartRoutingDecision = NonNullable<
  z.infer<typeof sessionConfigStateSchema>["smartRouting"]
>;

/**
 * Smart 决策值比较（specs/smart-routing-v3.md B3 UI 消费面）。
 * CLI 投影（config patch 变化门）与 renderer 摄取链（trail 落记录）共用同一份语义，
 * 防止两侧各写一份比较导致「投影判定无变化、摄取判定有变化」的漂移。
 */
export function sameSmartRoutingDecision(
  left: SmartRoutingDecision | null | undefined,
  right: SmartRoutingDecision | null | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.tier === right.tier && left.note === right.note;
}
