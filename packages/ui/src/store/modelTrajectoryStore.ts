import { create } from "zustand";

import type { SmartRoutingDecision } from "@zcode/shared/zcode-protocol-v4";

/** B3 数据面（specs/smart-routing-v3.md）：Smart 换档决策档位。 */
export type SmartRoutingTier = SmartRoutingDecision["tier"];

/** Smart 换档决策记录：档位、原因与落地帧水位。 */
export interface SmartRoutingDecisionRecord {
  /** 幂等/排序键：决策落地帧右端点 seq；迟到/乱序帧被拒绝。 */
  seq: number;
  tier: SmartRoutingTier;
  /** 决策原因（CLI 决策 note 原文透传）。 */
  note: string;
  /** renderer 摄取时刻（墙钟毫秒，仅供展示排序参考）。 */
  at: number;
}

const SMART_ROUTING_TRAIL_MAX = 100;
const EMPTY_SMART_ROUTING_TRAIL: readonly SmartRoutingDecisionRecord[] = [];

export interface ModelTrajectoryOpenRequest {
  requestId: string;
  taskId: string;
  /** workspaceIdentity?.trim() || workspacePath，用于定位目标 workspace 侧边栏。 */
  workspaceKey: string;
  title?: string | null;
}

export interface ModelTrajectoryStoreState {
  pendingRequest: ModelTrajectoryOpenRequest | null;
  /** sessionId → Smart 换档决策轨迹（renderer 生命周期累积，见 spec 幂等与边界）。 */
  smartRoutingTrailBySession: Record<string, SmartRoutingDecisionRecord[]>;
  requestOpen: (request: Omit<ModelTrajectoryOpenRequest, "requestId">) => void;
  consumeRequest: (requestId: string) => void;
  /** 唯一写入方：renderer 会话事件摄取链（conversationProjectionStore）。 */
  recordSmartRoutingDecision: (sessionKey: string, record: SmartRoutingDecisionRecord) => void;
  clearSmartRoutingTrail: (sessionKey?: string) => void;
}

declare global {
  interface Window {
    __zcodeModelTrajectoryStoreE2E?: typeof useModelTrajectoryStore;
  }
}

let requestSeq = 0;

/** 打开桥 + B3 数据面单例（职责见 State 字段注释与 spec）。 */
export const useModelTrajectoryStore = create<ModelTrajectoryStoreState>((set) => ({
  pendingRequest: null,
  smartRoutingTrailBySession: {},
  requestOpen: (request) => {
    requestSeq += 1;
    set({ pendingRequest: { ...request, requestId: `model-trajectory-open:${requestSeq}` } });
  },
  consumeRequest: (requestId) => {
    set((state) =>
      state.pendingRequest?.requestId === requestId ? { pendingRequest: null } : state,
    );
  },
  recordSmartRoutingDecision: (sessionKey, record) => {
    set((state) => {
      const trail = state.smartRoutingTrailBySession[sessionKey] ?? [];
      const last = trail.at(-1);
      // exactly-once：seq 不大于最后记录的迟到/乱序/重复帧直接拒绝。
      if (last && record.seq <= last.seq) return state;
      const bounded =
        trail.length >= SMART_ROUTING_TRAIL_MAX
          ? [...trail.slice(trail.length - SMART_ROUTING_TRAIL_MAX + 1), record]
          : [...trail, record];
      return {
        smartRoutingTrailBySession: {
          ...state.smartRoutingTrailBySession,
          [sessionKey]: bounded,
        },
      };
    });
  },
  clearSmartRoutingTrail: (sessionKey) => {
    set((state) => {
      if (!sessionKey) {
        return { smartRoutingTrailBySession: {} };
      }
      if (!(sessionKey in state.smartRoutingTrailBySession)) return state;
      const next = { ...state.smartRoutingTrailBySession };
      delete next[sessionKey];
      return { smartRoutingTrailBySession: next };
    });
  },
}));

/** 查询面：读取某 session 的 trail；无记录返回共享空数组，selector 引用稳定。 */
export function selectSmartRoutingTrail(
  state: ModelTrajectoryStoreState,
  sessionKey: string | null | undefined,
): readonly SmartRoutingDecisionRecord[] {
  return (
    (sessionKey ? state.smartRoutingTrailBySession[sessionKey] : undefined) ??
    EMPTY_SMART_ROUTING_TRAIL
  );
}

// E2E 需要在双 workspace 壳中直接验证 request bridge → 目标 workspace side pane 的完整链路。
// Header 菜单只绑定当前 header 的 activeTaskId，不能作为分屏壳（split pane）的稳定测试入口；
// 与 __zcodeSessionStoreE2E 保持同一模式，暴露 store 本身而不是另造测试专用业务实现。
if (typeof window !== "undefined") {
  window.__zcodeModelTrajectoryStoreE2E = useModelTrajectoryStore;
}
