import {
  selectSmartRoutingTrail,
  useModelTrajectoryStore,
  type SmartRoutingDecisionRecord,
} from "@/store/modelTrajectoryStore.js";

/**
 * B3 查询面（specs/smart-routing-v3.md）：按 sessionId 读取 Smart 换档决策轨迹。
 * 数据由 renderer 会话事件摄取链累积（renderer 生命周期内）；
 * UI 形态（badge / 内联标记，spec 待定项 2）由消费方决定。
 */
export function useSmartRoutingTrail(
  sessionKey: string | null | undefined,
): readonly SmartRoutingDecisionRecord[] {
  return useModelTrajectoryStore((state) => selectSmartRoutingTrail(state, sessionKey));
}
