import { randomUUID } from "node:crypto";
import type {
  AutomationRecording,
  AutomationReplayOnFailure,
  AutomationReplayReport,
  AutomationReplayStepResult,
} from "@zcode/shared";
import type { BrowserActionExecutor } from "./automationReplayExecutors.js";

/**
 * 回放引擎（specs/record-replay.md）：逐步执行录制件并产出报告。
 *
 * - 引擎不触碰文件系统：截图与报告经注入的 sink 落盘（由存储层实现，保持唯一写入点）。
 * - 步骤严格按 seq 升序执行；wait 由引擎本地延时，其余派发到注入的执行面。
 * - 失败策略：abort（默认）= 失败步附截图后中断，剩余步骤不执行也不记录；
 *   skip = 失败步记 skipped（附截图）继续后续步骤。
 * - 回放状态只进报告，不回写录制件。
 */

/** 回放产物落盘接口；由 AutomationRecordingStore 实现（报告/截图目录约定见存储层）。 */
export interface AutomationReplayArtifactSink {
  saveScreenshot(
    recordingId: string,
    runId: string,
    seq: number,
    base64Png: string,
  ): Promise<string>;
  saveReport(report: AutomationReplayReport): Promise<string>;
}

export interface AutomationReplayEngineDeps {
  executor: BrowserActionExecutor;
  sink: AutomationReplayArtifactSink;
  now?: () => number;
  newRunId?: () => string;
  /** 可注入延时（测试用），缺省真实 setTimeout。 */
  delay?: (ms: number) => Promise<void>;
}

/** wait 步在引擎内本地延时；测试注入假 delay 避免真实等待。 */
function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface AutomationReplayRunResult {
  report: AutomationReplayReport;
  /** 报告文件绝对路径。 */
  reportPath: string;
}

/** 失败时尽力截图；截图失败不改变回放语义，仅把原因并入步骤 error。 */
async function captureFailureScreenshot(
  executor: BrowserActionExecutor,
  sink: AutomationReplayArtifactSink,
  recordingId: string,
  runId: string,
  seq: number,
): Promise<{ screenshotPath?: string; errorSuffix?: string }> {
  try {
    const shot = await executor.captureScreenshot();
    if (!shot.ok || !shot.base64Png) {
      return { errorSuffix: `; screenshot unavailable (${shot.error ?? "no image"})` };
    }
    const path = await sink.saveScreenshot(recordingId, runId, seq, shot.base64Png);
    return { screenshotPath: path };
  } catch (error) {
    return {
      errorSuffix: `; screenshot failed (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

export function createAutomationReplayEngine(deps: AutomationReplayEngineDeps): {
  replay(
    recording: AutomationRecording,
    onFailure: AutomationReplayOnFailure,
  ): Promise<AutomationReplayRunResult>;
} {
  const now = deps.now ?? Date.now;
  const newRunId = deps.newRunId ?? (() => `run-${randomUUID()}`);
  const delay = deps.delay ?? defaultDelay;

  return {
    async replay(recording, onFailure) {
      const runId = newRunId();
      const startedAt = now();
      const steps = [...recording.steps].sort((a, b) => a.seq - b.seq);
      const results: AutomationReplayStepResult[] = [];
      let aborted = false;

      for (const step of steps) {
        const stepStartedAt = now();
        const finishStep = (
          partial: Omit<AutomationReplayStepResult, "seq" | "action" | "elapsedMs">,
        ): AutomationReplayStepResult => ({
          seq: step.seq,
          action: step.action,
          elapsedMs: now() - stepStartedAt,
          ...partial,
        });

        // wait：引擎本地延时，不占用执行面。
        if (step.action === "wait") {
          await delay(step.durationMs ?? 0);
          results.push(finishStep({ status: "succeeded" }));
          continue;
        }

        const outcome = await deps.executor.executeStep(step);
        if (outcome.ok) {
          results.push(finishStep({ status: "succeeded" }));
          continue;
        }

        // 失败步：尽力截图（abort/skip 都截图，便于诊断目标页面变化）。
        const shot = await captureFailureScreenshot(
          deps.executor,
          deps.sink,
          recording.id,
          runId,
          step.seq,
        );
        const errorText = `${outcome.error ?? "unknown_error"}${shot.errorSuffix ?? ""}`;
        results.push(
          finishStep({
            status: "failed",
            error: errorText,
            ...(shot.screenshotPath ? { screenshotPath: shot.screenshotPath } : {}),
          }),
        );
        if (onFailure === "abort") {
          aborted = true;
          break;
        }
        // skip 策略：把该失败步改记 skipped（保留截图与原因），继续执行后续步骤。
        results[results.length - 1] = finishStep({
          status: "skipped",
          error: errorText,
          ...(shot.screenshotPath ? { screenshotPath: shot.screenshotPath } : {}),
        });
      }

      const hasFailure = results.some((result) => result.status === "failed");
      const report: AutomationReplayReport = {
        recordingId: recording.id,
        runId,
        // abort 中断或存在失败步 → failed；skip 策略下全 skipped/succeeded 视为 completed。
        status: aborted || hasFailure ? "failed" : "completed",
        onFailure,
        executorSurface: deps.executor.surface,
        steps: results,
        startedAt,
        finishedAt: now(),
      };
      const reportPath = await deps.sink.saveReport(report);
      return { report, reportPath };
    },
  };
}
