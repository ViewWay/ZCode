/* 浏览器录制中的状态条（specs/record-replay.md v1.1）：live 步数/URL 来自 host
   活动采集会话（唯一事实源），UI 只投影；停止保存/取消动作经回调上抛给
   BrowserRecordingsCard（服务调用与确认弹窗都归卡片，状态条保持纯展示）。 */
import { Circle, Loader2 } from "lucide-react";
import type { AutomationRecordingCaptureState } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function BrowserRecordingCaptureBar({
  capture,
  busy,
  onStop,
  onCancel,
}: {
  capture: AutomationRecordingCaptureState;
  busy: boolean;
  onStop: () => void;
  onCancel: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      data-browser-recording-active
      className="flex flex-col gap-2 rounded-xl border border-card-border bg-background p-3 sm:flex-row sm:items-center"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-destructive">
            <Circle className="size-2 fill-current" aria-hidden="true" />
            {intl.formatMessage({ id: "browserRecordings.recordingBadge" })}
          </span>
          <span className="truncate text-ui-base font-normal leading-5 text-foreground-subtle">
            {intl.formatMessage(
              { id: "browserRecordings.recordingMeta" },
              { steps: String(capture.stepCount) },
            )}
          </span>
        </div>
        {capture.lastUrl ? (
          <span className="truncate text-ui-base font-normal leading-5 text-foreground-subtlest">
            {capture.lastUrl}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button type="button" variant="default" size="sm" disabled={busy} onClick={onStop}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          {intl.formatMessage({ id: "browserRecordings.stopAndSave" })}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onCancel}>
          {intl.formatMessage({ id: "browserRecordings.cancelRecord" })}
        </Button>
      </div>
    </div>
  );
}
