import type { AutomationRecordingStep, BrowserCommand, BrowserCommandResult } from "@zcode/shared";

/**
 * 回放执行面（specs/record-replay.md）：回放引擎只依赖这个接口，不感知
 * 受控浏览器的实现细节。真实执行面由 createBrowserCommandActionExecutor 适配到
 * 既有 BrowserCommand 契约（与 host↔main browserControlMainBridge.execute 同源）；
 * 无受控浏览器执行 API 可用时注入 createUnavailableBrowserActionExecutor（诚实失败）。
 */

/** 单步执行结果：结构化返回，不 throw；ok=false 时 error 为稳定错误说明。 */
export interface BrowserActionStepOutcome {
  ok: boolean;
  /** 失败错误码/信息（如 "selector_not_found"、"unavailable"）。 */
  error?: string;
  /** extract 步骤：页面快照序列化数据（执行器侧截断到 EXTRACT_DATA_MAX_CHARS）。 */
  data?: string;
}

export interface BrowserActionExecutor {
  /** 执行面标识；写入回放报告，用于诊断接线来源。 */
  readonly surface: string;
  /** 执行单步动作（wait 由引擎本地处理，不会派发到执行器）。 */
  executeStep(step: AutomationRecordingStep): Promise<BrowserActionStepOutcome>;
  /** 失败截图（base64 png）；尽力而为，不可用返回 ok=false，不阻断回放收尾。 */
  captureScreenshot(): Promise<{ ok: boolean; base64Png?: string; error?: string }>;
}

/** BrowserCommand 派发函数；与 browserControlMainBridge.execute 的 command 入参同源。 */
export type BrowserCommandDispatcher = (command: BrowserCommand) => Promise<BrowserCommandResult>;

const LOCATOR_TIMEOUT_MS = 3_000;

/** extract 步骤结果数据上限（超出截断，防止巨型页面快照撑爆报告 JSON）。 */
export const EXTRACT_DATA_MAX_CHARS = 16_000;

function truncateExtractData(text: string): string {
  return text.length > EXTRACT_DATA_MAX_CHARS
    ? `${text.slice(0, EXTRACT_DATA_MAX_CHARS)}…[truncated]`
    : text;
}

function resultToOutcome(result: BrowserCommandResult): BrowserActionStepOutcome {
  if (result.ok) return { ok: true };
  const error = result.error;
  return { ok: false, error: error ? `${error.code}: ${error.message}` : "unknown_error" };
}

/** 把录制步骤映射为既有 BrowserCommand；映射不了的动作按 step_invalid 失败。 */
export function automationRecordingStepToBrowserCommand(
  step: AutomationRecordingStep,
): BrowserCommand | null {
  switch (step.action) {
    case "navigate":
      // schema 已约束 navigate 必有 value。
      return step.value !== undefined ? { method: "navigate", url: step.value } : null;
    case "click":
      if (!step.target) return null;
      if (step.target.kind === "selector") {
        // selector 点击走 playwright locator（与浏览器录制动作 click 同一映射）。
        return {
          method: "playwright",
          action: {
            name: "locator",
            selector: step.target.selector,
            operation: "click",
            timeoutMs: LOCATOR_TIMEOUT_MS,
          },
        };
      }
      // 坐标点击走 CDP 视觉坐标。
      return { method: "click", x: step.target.x, y: step.target.y };
    case "type":
      if (!step.target || step.target.kind !== "selector" || step.value === undefined) return null;
      // 输入走 locator fill（整体替换输入值，与浏览器录制动作 type 同一映射）。
      return {
        method: "playwright",
        action: {
          name: "locator",
          selector: step.target.selector,
          operation: "fill",
          value: step.value,
          timeoutMs: LOCATOR_TIMEOUT_MS,
        },
      };
    case "scroll":
      // scroll 的 y 即滚轮 deltaY（无 ref 时 main 在 (0,0) 派发 wheel delta）。
      return step.deltaY !== undefined ? { method: "scroll", y: step.deltaY } : null;
    case "extract":
      // 整页/带 selector 的提取统一走 snapshot；v1 不逐字段抽取。
      return { method: "snapshot" };
    default:
      // wait 由引擎本地延时，不应进入执行器。
      return null;
  }
}

/**
 * 真实执行面适配器：步骤 → BrowserCommand → 注入的派发函数。
 * 派发函数应由宿主接到受控浏览器执行链路（如 browserControlMainBridge.execute）；
 * v1 桌面手动回放尚无可绑定的浏览器会话上下文，接线缺口见 specs/record-replay.md。
 */
export function createBrowserCommandActionExecutor(deps: {
  dispatcher: BrowserCommandDispatcher;
  surface?: string;
}): BrowserActionExecutor {
  return {
    surface: deps.surface ?? "browser-command-bridge",
    async executeStep(step) {
      const command = automationRecordingStepToBrowserCommand(step);
      if (!command) {
        return { ok: false, error: `step_invalid: action ${step.action} cannot be dispatched` };
      }
      try {
        const result = await deps.dispatcher(command);
        const outcome = resultToOutcome(result);
        if (step.action === "extract" && outcome.ok) {
          // extract 数据面：快照结果序列化进结果（报告以 label/seq 为键），超限截断。
          return {
            ok: true,
            data: truncateExtractData(JSON.stringify(result.snapshot ?? null)),
          };
        }
        return outcome;
      } catch (error) {
        return {
          ok: false,
          error: `dispatch_failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    async captureScreenshot() {
      try {
        const result = await deps.dispatcher({ method: "screenshot" });
        if (!result.ok || !result.image?.base64) {
          return {
            ok: false,
            error: result.error ? `${result.error.code}: ${result.error.message}` : "no_image",
          };
        }
        return { ok: true, base64Png: result.image.base64 };
      } catch (error) {
        return {
          ok: false,
          error: `dispatch_failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

/**
 * 结构化 no-op 执行面：宿主没有可用的受控浏览器执行 API 时使用。
 * 每步返回 unavailable 失败（带执行面说明），绝不伪造成功；回放会按失败策略
 * 产出诚实报告，报告中 executorSurface 指明原因。
 */
export function createUnavailableBrowserActionExecutor(reason: string): BrowserActionExecutor {
  return {
    surface: `unavailable: ${reason}`,
    async executeStep() {
      return { ok: false, error: `unavailable: ${reason}` };
    },
    async captureScreenshot() {
      return { ok: false, error: `unavailable: ${reason}` };
    },
  };
}
