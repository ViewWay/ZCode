/* 浏览器录制定时回放编辑器（specs/record-replay.md v1.2）：
   每行时钟按钮打开 Dialog：cron 表达式输入 + 启用开关 + 保存/清除。
   非法 cron 由服务端校验抛错，行内 toast 提示；清除 = 移除调度。 */
import { useState } from "react";
import { Clock } from "lucide-react";
import type { AutomationRecording } from "@zcode/shared";
import type { IAutomationRecordingService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatRecordingTitleLocal(recording: AutomationRecording): string {
  return recording.title?.trim() || recording.id;
}

export function BrowserRecordingScheduleEditor({
  recording,
  automationRecordingService,
  onSaved,
}: {
  recording: AutomationRecording;
  automationRecordingService: IAutomationRecordingService;
  onSaved: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const [cronExpr, setCronExpr] = useState(recording.schedule?.cronExpr ?? "0 * * * *");
  const [enabled, setEnabled] = useState(recording.schedule?.enabled ?? false);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await automationRecordingService.setSchedule(recording.id, {
        cronExpr: cronExpr.trim(),
        enabled,
      });
      logger.info("[browserRecordings] schedule saved", { recording: recording.id });
      setOpen(false);
      onSaved();
    } catch (saveError) {
      toast(
        intl.formatMessage(
          { id: "browserRecordings.scheduleSaveFailed" },
          { message: toMessage(saveError) },
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    try {
      await automationRecordingService.setSchedule(recording.id, undefined);
      setOpen(false);
      onSaved();
    } catch (clearError) {
      toast(
        intl.formatMessage(
          { id: "browserRecordings.scheduleSaveFailed" },
          { message: toMessage(clearError) },
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="shrink-0"
        disabled={saving}
        aria-label={intl.formatMessage({ id: "browserRecordings.scheduleEdit" })}
        onClick={() => setOpen(true)}
      >
        <Clock className="size-4" aria-hidden="true" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md gap-3">
          <DialogHeader>
            <DialogTitle>
              {intl.formatMessage(
                { id: "browserRecordings.scheduleTitle" },
                { title: formatRecordingTitleLocal(recording) },
              )}
            </DialogTitle>
            <DialogDescription>
              {intl.formatMessage({ id: "browserRecordings.scheduleDescription" })}
            </DialogDescription>
          </DialogHeader>
          <input
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-ui-base outline-none focus:border-brand"
            value={cronExpr}
            onChange={(event) => setCronExpr(event.target.value)}
            placeholder="0 * * * *"
            aria-label={intl.formatMessage({ id: "browserRecordings.scheduleCronLabel" })}
          />
          <label className="flex items-center gap-2 text-ui-base">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
            {intl.formatMessage({ id: "browserRecordings.scheduleEnabled" })}
          </label>
          <div className="flex justify-end gap-2">
            {recording.schedule ? (
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={() => void handleClear()}
              >
                {intl.formatMessage({ id: "browserRecordings.scheduleClear" })}
              </Button>
            ) : null}
            <Button type="button" onClick={() => void handleSave()} disabled={saving}>
              {intl.formatMessage({ id: "browserRecordings.scheduleSave" })}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
