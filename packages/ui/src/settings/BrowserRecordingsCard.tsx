/* 浏览器操作录制列表（specs/record-replay.md）：
   「自动化」页已创建任务区之后的录制件来源分组。每行 = 标题（缺省回退名）+
   来源 recording 徽章 + 步骤数 + 创建时间 + 手动回放/删除按钮。
   v1.1 录制入口：开始录制（隐私确认，type 值含敏感文本原样入库）→ 录制中状态条
   （getCaptureState 轮询步数/URL）→ 停止并保存 / 取消。
   数据走 IAutomationRecordingService（Desktop 本地 Host 提供）；服务缺失（远端/
   Web host）时整块隐藏。回放为同步整次报告：完成后 toast 摘要，失败步附原因。 */
import { useCallback, useEffect, useState } from "react";
import { Circle, Loader2 } from "lucide-react";
import type {
  AutomationRecording,
  AutomationRecordingCaptureState,
  AutomationReplayReport,
} from "@zcode/shared";
import type { IAutomationRecordingService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { cn } from "@/components/lib/utils.js";
import { AutomationRunNowIcon } from "@/settings/AutomationIcons.js";
import { AutomationTrashIcon } from "@/settings/AutomationDesignPrimitives.js";
import { BrowserRecordingCaptureBar } from "@/settings/BrowserRecordingCaptureBar.js";
import { formatDateTime } from "@/settings/automationFormat.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatRecordingTitle(recording: AutomationRecording, fallback: string): string {
  return recording.title?.trim() || fallback;
}

/** ISO 创建时间 → 本地 YYYY-MM-DD HH:MM（与定时任务卡同格式）。 */
function formatCreatedAt(recording: AutomationRecording): string {
  const ts = Date.parse(recording.createdAt);
  return Number.isFinite(ts) ? formatDateTime(ts) : "-";
}

/** 回放结果 toast 摘要：成功给步数统计；失败定位首个失败步并附原因。 */
function describeReplayOutcome(
  report: AutomationReplayReport,
  formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) => string,
): { message: string; failed: boolean } {
  const failedStep = report.steps.find((step) => step.status === "failed");
  if (report.status === "completed" && !failedStep) {
    return {
      message: formatMessage(
        { id: "browserRecordings.replayDone" },
        {
          total: String(report.steps.length),
          skipped: String(report.steps.filter((step) => step.status === "skipped").length),
        },
      ),
      failed: false,
    };
  }
  return {
    message: formatMessage(
      { id: "browserRecordings.replayFailedAt" },
      {
        seq: String(failedStep?.seq ?? 0),
        action: failedStep?.action ?? "-",
        error: (failedStep?.error ?? report.error ?? "").slice(0, 200),
      },
    ),
    failed: true,
  };
}

/** 录制中状态条的步数/URL 轮询间隔（host 侧采集轮询 1s，UI 不需要更密）。 */
const CAPTURE_STATE_POLL_MS = 2_000;

export function BrowserRecordingsCard({
  automationRecordingService,
}: {
  automationRecordingService: IAutomationRecordingService | undefined;
}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const [recordings, setRecordings] = useState<AutomationRecording[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyRecordingId, setBusyRecordingId] = useState<string | null>(null);
  const [capture, setCapture] = useState<AutomationRecordingCaptureState | null>(null);
  const [captureBusy, setCaptureBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!automationRecordingService) return;
    setLoading(true);
    try {
      setRecordings(await automationRecordingService.list());
      setError(null);
    } catch (listError) {
      const message = toMessage(listError);
      logger.error("[browserRecordings] 加载录制件失败", message);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [automationRecordingService]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 录制中：轮询活动会话状态（步数/URL）；host 侧已无会话（异常终止）时收敛为空。
  useEffect(() => {
    if (!automationRecordingService || !capture) return;
    let disposed = false;
    const timer = setInterval(() => {
      void automationRecordingService
        .getCaptureState()
        .then((state) => {
          if (!disposed) setCapture(state);
        })
        .catch((pollError) => {
          logger.warn("[browserRecordings] 读取录制状态失败", { message: toMessage(pollError) });
        });
    }, CAPTURE_STATE_POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [automationRecordingService, capture?.captureId]);

  const handleStartRecord = async () => {
    if (!automationRecordingService || capture || captureBusy) return;
    // 隐私确认：type 步骤会原样记录输入文本（含密码），回放需要真实值，不做脱敏。
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "browserRecordings.recordConfirmTitle" }),
      description: intl.formatMessage({ id: "browserRecordings.recordConfirmDescription" }),
      confirmLabel: intl.formatMessage({ id: "browserRecordings.record" }),
    });
    if (!confirmed) return;
    setCaptureBusy(true);
    try {
      setCapture(await automationRecordingService.startCapture());
    } catch (startError) {
      const message = toMessage(startError);
      logger.error("[browserRecordings] 开始录制失败", message);
      toast(intl.formatMessage({ id: "browserRecordings.recordStartFailed" }, { message }));
    } finally {
      setCaptureBusy(false);
    }
  };

  const handleStopRecord = async () => {
    if (!automationRecordingService || !capture || captureBusy) return;
    setCaptureBusy(true);
    try {
      const recording = await automationRecordingService.stopCapture();
      setCapture(null);
      toast(
        intl.formatMessage(
          { id: "browserRecordings.recordSaved" },
          {
            title: formatRecordingTitle(
              recording,
              intl.formatMessage({ id: "browserRecordings.fallbackName" }),
            ),
            steps: String(recording.steps.length),
          },
        ),
      );
      await refresh();
    } catch (stopError) {
      const message = toMessage(stopError);
      logger.error("[browserRecordings] 停止录制失败", message);
      setCapture(null);
      toast(intl.formatMessage({ id: "browserRecordings.recordStopFailed" }, { message }));
    } finally {
      setCaptureBusy(false);
    }
  };

  const handleCancelRecord = async () => {
    if (!automationRecordingService || !capture || captureBusy) return;
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "browserRecordings.cancelConfirmTitle" }),
      description: intl.formatMessage({ id: "browserRecordings.cancelConfirmDescription" }),
      confirmLabel: intl.formatMessage({ id: "browserRecordings.cancelRecord" }),
    });
    if (!confirmed) return;
    setCaptureBusy(true);
    try {
      await automationRecordingService.cancelCapture();
      setCapture(null);
      toast(intl.formatMessage({ id: "browserRecordings.recordCancelled" }));
    } catch (cancelError) {
      const message = toMessage(cancelError);
      logger.error("[browserRecordings] 取消录制失败", message);
      setCapture(null);
      toast(intl.formatMessage({ id: "browserRecordings.recordStopFailed" }, { message }));
    } finally {
      setCaptureBusy(false);
    }
  };

  // 服务缺失（远端/Web host）时整块隐藏，不渲染空壳。
  if (!automationRecordingService) return null;

  const handleReplay = async (recording: AutomationRecording) => {
    if (busyRecordingId) return;
    setBusyRecordingId(recording.id);
    setError(null);
    try {
      const report = await automationRecordingService.replay(recording.id);
      const outcome = describeReplayOutcome(report, intl.formatMessage);
      if (outcome.failed) {
        toast(
          intl.formatMessage(
            { id: "browserRecordings.replayFailedTitle" },
            { message: outcome.message },
          ),
        );
        logger.warn("[browserRecordings] 回放失败", {
          recordingId: recording.id,
          runId: report.runId,
          executorSurface: report.executorSurface,
        });
      } else {
        toast(outcome.message);
      }
    } catch (replayError) {
      // 录制件损坏/不存在：整体拒绝（未执行任何步骤），把原因透给用户。
      const message = toMessage(replayError);
      logger.error("[browserRecordings] 回放被拒绝", { recordingId: recording.id, message });
      toast(intl.formatMessage({ id: "browserRecordings.replayRejected" }, { message }));
    } finally {
      setBusyRecordingId(null);
    }
  };

  const handleDelete = async (recording: AutomationRecording) => {
    const confirmed = await confirmDialog({
      title: intl.formatMessage(
        { id: "browserRecordings.deleteConfirmTitle" },
        {
          name: formatRecordingTitle(
            recording,
            intl.formatMessage({ id: "browserRecordings.fallbackName" }),
          ),
        },
      ),
      description: intl.formatMessage({ id: "browserRecordings.deleteConfirmDescription" }),
      confirmLabel: intl.formatMessage({ id: "common.delete" }),
    });
    if (!confirmed) return;
    setBusyRecordingId(recording.id);
    try {
      await automationRecordingService.delete(recording.id);
      await refresh();
    } catch (deleteError) {
      const message = toMessage(deleteError);
      logger.error("[browserRecordings] 删除录制件失败", { recordingId: recording.id, message });
      toast(intl.formatMessage({ id: "browserRecordings.deleteFailed" }, { message }));
    } finally {
      setBusyRecordingId(null);
    }
  };

  return (
    <section className="flex w-full flex-col gap-4" data-browser-recordings>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
          {intl.formatMessage({ id: "browserRecordings.sectionTitle" })}
        </h2>
        {capture ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 gap-1"
            disabled={captureBusy}
            onClick={() => void handleStartRecord()}
          >
            {captureBusy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Circle className="size-4" aria-hidden="true" />
            )}
            {intl.formatMessage({ id: "browserRecordings.record" })}
          </Button>
        )}
      </div>
      {capture ? (
        <BrowserRecordingCaptureBar
          capture={capture}
          busy={captureBusy}
          onStop={() => void handleStopRecord()}
          onCancel={() => void handleCancelRecord()}
        />
      ) : null}
      {error ? (
        <div className="rounded-xl border border-card-border bg-background p-3 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "browserRecordings.loadFailed" }, { error })}
        </div>
      ) : null}
      {loading && recordings.length === 0 ? (
        <div className="flex items-center gap-2 p-3 text-ui-base text-foreground-subtle">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {intl.formatMessage({ id: "common.loading" })}
        </div>
      ) : recordings.length === 0 ? (
        <div className="rounded-xl border border-card-border bg-background p-3 text-center text-ui-base font-normal text-foreground-subtlest">
          {intl.formatMessage({ id: "browserRecordings.empty" })}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {recordings.map((recording) => {
            const busy = busyRecordingId === recording.id;
            return (
              <li
                key={recording.id}
                className={cn(
                  "flex min-w-0 items-center gap-3 rounded-xl border border-card-border bg-background p-3",
                  busy && "opacity-70",
                )}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-ui-base font-medium leading-5 text-foreground">
                      {formatRecordingTitle(
                        recording,
                        intl.formatMessage({ id: "browserRecordings.fallbackName" }),
                      )}
                    </span>
                    {/* 来源徽章：录制件来自浏览器操作录制（recording），非 cron 定时任务。 */}
                    <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
                      {intl.formatMessage({ id: "browserRecordings.sourceBadge" })}
                    </span>
                  </div>
                  <span className="truncate text-ui-base font-normal leading-5 text-foreground-subtle">
                    {intl.formatMessage(
                      { id: "browserRecordings.meta" },
                      {
                        steps: String(recording.steps.length),
                        createdAt: formatCreatedAt(recording),
                      },
                    )}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-1"
                  disabled={busyRecordingId !== null}
                  onClick={() => void handleReplay(recording)}
                >
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <AutomationRunNowIcon className="size-4" aria-hidden="true" />
                  )}
                  {intl.formatMessage({ id: "browserRecordings.replay" })}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  disabled={busyRecordingId !== null}
                  aria-label={intl.formatMessage({ id: "common.delete" })}
                  onClick={() => void handleDelete(recording)}
                >
                  <AutomationTrashIcon />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
