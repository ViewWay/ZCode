// ============================================================
// Smart Routing Port - Smart v2 套餐额度感知路由的宿主决策面
// ============================================================
// Smart 虚拟选择（smart/auto）的 v2 路由决策端口。与 SessionChatPort 同族：
// 协议宿主（bootstrap zcode-protocol）提供实现——已登录 Coding Plan 套餐按剩余
// 额度择优、低额度自动用重置卡、套餐耗尽回落 v1 目录择优；端口缺席时 core 完全
// 保持 v1 行为（解析期目录择优）。每次决策必须携带人话 note，供会话侧提示与日志。

/** Smart 虚拟选择的固定身份（与 provider v1 smart-routing 的常量同值）。 */
export const SMART_PROVIDER_ID = "smart";
export const SMART_MODEL_ID = "auto";

/** 判定一个选择是否 Smart 虚拟选择；core turn 与宿主端口共用同一把尺。 */
export function isSmartRoutingSelection(
  selection: { providerId?: string; modelId?: string } | null | undefined,
): boolean {
  return (
    selection?.providerId === SMART_PROVIDER_ID && selection?.modelId === SMART_MODEL_ID
  );
}

/**
 * 一次 Smart 路由决策：
 * - plan：选中套餐 provider 的具体模型（本轮执行选择改写为其 providerId/modelId）。
 * - catalog：套餐不可用/额度不足，回落 v1 目录择优；providerId/modelId 为宿主
 *   已算好的 v1 择优结果（宿主进程持有目录），可选——缺席时调用方保持 v1 原行为。
 * - unavailable：套餐与目录都无候选，调用方走既有 provider-not-found 路径。
 */
export type SmartRoutingDecision =
  | {
      kind: "plan";
      providerId: string;
      modelId: string;
      /** 路由模型要求的思考档位（目录 optionSpecs 末档）；缺席=模型无档位要求。 */
      options?: { reasoningLevel: string };
      /** 任务档位：pro=复杂（GLM-5.3 级），flash=简单（Flash 级/免费轨优先）。 */
      tier: "pro" | "flash";
      note: string;
    }
  | {
      kind: "catalog";
      note: string;
      providerId?: string;
      modelId?: string;
      options?: { reasoningLevel: string };
    }
  | { kind: "unavailable"; note: string };

export interface SmartRoutingPort {
  /**
   * 获取本轮 Smart 选择的执行决策。taskPreview 为本轮用户输入预览（截断即可），
   * 供宿主做任务档位评估（复杂→pro 档，简单→flash 档/免费轨优先）；
   * 实现方自行兜底，不允许向调用方抛错阻断 turn。
   */
  getRoutingDecision(input?: {
    taskPreview?: string;
    /** 会话内轮次（0 基）；深会话按任务复杂处理（specs/smart-routing-v3.md s2）。 */
    turnIndex?: number;
  }): Promise<SmartRoutingDecision>;
}
