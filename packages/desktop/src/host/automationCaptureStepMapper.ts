import type { AutomationCaptureRawEvent, AutomationRecordingStep } from "@zcode/shared";

/**
 * 原始采集事件 → 录制步骤映射（specs/record-replay.md v1.1）。
 *
 * 纯函数、无 IO、可注入窗口参数：连击合并、同字段取后值、scroll 同向聚合、
 * 长间隔插 wait、总数截断。输出直接交给 store.save 的 recording schema 收口。
 */

/** 噪声过滤窗口与上限（spec 契约值）；导出供单测与调用方覆盖。 */
export interface CaptureMappingOptions {
  /** 同目标连击合并窗口：同 selector/同坐标点击在该间隔内合并为一步。 */
  clickMergeWindowMs?: number;
  /** 同字段连续 change 取后值的窗口。 */
  changeMergeWindowMs?: number;
  /** 同方向相邻 scroll 聚合窗口。 */
  scrollMergeWindowMs?: number;
  /** 相邻步骤间隔达到该值才插入 wait。 */
  waitStepMinMs?: number;
  /** wait 封顶（schema durationMs 上限 60000）。 */
  waitStepMaxMs?: number;
  /** 步骤总数上限（schema steps 上限 500）；超出截断（丢弃尾部）。 */
  maxSteps?: number;
}

export const DEFAULT_CAPTURE_MAPPING_OPTIONS: Required<CaptureMappingOptions> = {
  clickMergeWindowMs: 500,
  changeMergeWindowMs: 500,
  scrollMergeWindowMs: 800,
  waitStepMinMs: 2_000,
  waitStepMaxMs: 60_000,
  maxSteps: 500,
};

/** wait durationMs 的 schema 上限（automation-recording.ts）；超上限会被 store.save 拒绝。 */
const WAIT_MAX_MS_SCHEMA = 60_000;
/** scroll deltaY 的 schema 上限。 */
const SCROLL_ABS_MAX = 100_000;

/** 带 ts 的中间步骤：wait 插入与 seq 分配前的形态。 */
interface TimestampedStep {
  ts: number;
  step: Omit<AutomationRecordingStep, "seq">;
}

/** 点击目标归一化：selector 缺省回退视口坐标（8px 网格合并抖动内的重复点击）。 */
function clickTargetKey(event: AutomationCaptureRawEvent & { type: "click" }): string {
  if (event.selector) return `s:${event.selector}`;
  return `p:${Math.round(event.x / 8)}:${Math.round(event.y / 8)}`;
}

/**
 * 合并相邻可合并事件（连击/同字段/同向滚动）。事件必须已按 ts 升序排列。
 */
function mergeRawEvents(
  events: readonly AutomationCaptureRawEvent[],
  options: Required<CaptureMappingOptions>,
): AutomationCaptureRawEvent[] {
  const merged: AutomationCaptureRawEvent[] = [];
  const lastClickAt = new Map<string, number>();
  const lastChangeAt = new Map<string, number>();
  for (const event of events) {
    const previous = merged[merged.length - 1];
    switch (event.type) {
      case "click": {
        const key = clickTargetKey(event);
        const lastAt = lastClickAt.get(key);
        // 连击合并：与同目标上一次点击间隔在窗口内则丢弃本次（双击/手抖噪声）。
        if (lastAt !== undefined && event.ts - lastAt <= options.clickMergeWindowMs) {
          break;
        }
        lastClickAt.set(key, event.ts);
        merged.push(event);
        break;
      }
      case "change": {
        const lastAt = lastChangeAt.get(event.selector) ?? Number.NEGATIVE_INFINITY;
        if (
          previous &&
          previous.type === "change" &&
          previous.selector === event.selector &&
          event.ts - lastAt <= options.changeMergeWindowMs
        ) {
          // 同字段短窗内连续提交：取后值（最终值语义），替换而非追加。
          merged[merged.length - 1] = event;
          lastChangeAt.set(event.selector, event.ts);
          break;
        }
        lastChangeAt.set(event.selector, event.ts);
        merged.push(event);
        break;
      }
      case "scroll": {
        if (
          previous &&
          previous.type === "scroll" &&
          Math.sign(previous.deltaY) === Math.sign(event.deltaY) &&
          event.ts - previous.ts <= options.scrollMergeWindowMs
        ) {
          const sum = previous.deltaY + event.deltaY;
          previous.deltaY = Math.max(-SCROLL_ABS_MAX, Math.min(SCROLL_ABS_MAX, sum));
          break;
        }
        merged.push(event);
        break;
      }
      case "navigate":
        merged.push(event);
        break;
    }
  }
  return merged;
}

/** 合并后事件 → 步骤体（不含 seq）；不可回放的事件在此丢弃。 */
function toTimestampedStep(event: AutomationCaptureRawEvent): TimestampedStep | null {
  switch (event.type) {
    case "navigate":
      return { ts: event.ts, step: { action: "navigate", value: event.url } };
    case "click":
      if (event.selector) {
        return {
          ts: event.ts,
          step: { action: "click", target: { kind: "selector", selector: event.selector } },
        };
      }
      // selector 构造失败回退视口坐标：坐标点击不依赖页面结构，跨结构变化存活率高。
      return {
        ts: event.ts,
        step: { action: "click", target: { kind: "point", x: event.x, y: event.y } },
      };
    case "change":
      return {
        ts: event.ts,
        step: {
          action: "type",
          target: { kind: "selector", selector: event.selector },
          value: event.value,
        },
      };
    case "scroll":
      return { ts: event.ts, step: { action: "scroll", deltaY: event.deltaY } };
  }
}

/** 合并窗口参数（展开默认值，便于测试注入部分覆盖）。 */
export function resolveCaptureMappingOptions(
  options?: CaptureMappingOptions,
): Required<CaptureMappingOptions> {
  return { ...DEFAULT_CAPTURE_MAPPING_OPTIONS, ...options };
}

/**
 * 把原始事件流映射为录制步骤。输入乱序时先按 ts 稳定排序；wait 由相邻步骤
 * 间隔启发产生；输出按时间顺序分配 seq（>=1）。
 */
export function mapCaptureEventsToSteps(
  events: readonly AutomationCaptureRawEvent[],
  options?: CaptureMappingOptions,
): AutomationRecordingStep[] {
  const resolved = resolveCaptureMappingOptions(options);
  const ordered = [...events].sort((a, b) => a.ts - b.ts);
  const merged = mergeRawEvents(ordered, resolved);

  const timestamped: TimestampedStep[] = [];
  for (const event of merged) {
    const mapped = toTimestampedStep(event);
    if (mapped) timestamped.push(mapped);
  }

  // 长间隔插 wait：只看相邻映射步骤的时间差（含首步前的等待——回放从头执行，
  // 首步前的间隔没有回放语义，跳过）。
  const withWaits: TimestampedStep[] = [];
  for (const current of timestamped) {
    const previous = withWaits.length > 0 ? withWaits[withWaits.length - 1] : undefined;
    if (previous) {
      const gap = current.ts - previous.ts;
      if (gap >= resolved.waitStepMinMs) {
        withWaits.push({
          // wait 的 ts 取前一步，保证后续间隔计算不被自身抬高。
          ts: previous.ts,
          step: {
            action: "wait",
            durationMs: Math.min(gap, Math.min(resolved.waitStepMaxMs, WAIT_MAX_MS_SCHEMA)),
          },
        });
      }
    }
    withWaits.push(current);
  }

  return withWaits.slice(0, resolved.maxSteps).map((item, index) => ({
    seq: index + 1,
    ...item.step,
  }));
}
