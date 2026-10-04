/* 浏览器录制步骤编辑器（specs/record-replay.md v1.3）：
   每行「步骤」按钮打开 Dialog：步骤列表（seq/action 摘要）+ navigate/type 的 value
   行内编辑 + 删除步骤 + 保存（整组替换，schema 校验 seq 升序与字段约束）。
   非法保存（seq 断档等）由服务端可读拒绝，行内 toast。 */
import { useState } from "react";
import { ListOrdered, Trash2 } from "lucide-react";
import type { AutomationRecording, AutomationRecordingStep } from "@zcode/shared";
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
import { Input } from "@/components/ui/input.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeStep(step: AutomationRecordingStep): string {
  if (step.action === "navigate") return step.value ?? "";
  if (step.action === "type") {
    return `${step.target?.kind === "selector" ? step.target.selector : ""} → ${step.value ?? ""}`;
  }
  if (step.action === "click") {
    return step.target?.kind === "selector"
      ? step.target.selector
      : step.target?.kind === "point"
        ? `${step.target.x},${step.target.y}`
        : "";
  }
  if (step.action === "wait") return `${step.durationMs ?? 0}ms`;
  if (step.action === "scroll") return String(step.deltaY ?? 0);
  return "";
}

/** value 可行内编辑的动作（navigate/type）；其余动作只读展示。 */
function isValueEditable(step: AutomationRecordingStep): boolean {
  return step.action === "navigate" || step.action === "type";
}

export function BrowserRecordingStepsEditor({
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
  const [draft, setDraft] = useState<AutomationRecordingStep[]>([]);
  const [saving, setSaving] = useState(false);

  const handleOpen = () => {
    setDraft(recording.steps.map((step) => ({ ...step })));
    setOpen(true);
  };

  const handleValueChange = (seq: number, value: string) => {
    setDraft((current) => current.map((step) => (step.seq === seq ? { ...step, value } : step)));
  };

  const handleDelete = (seq: number) => {
    setDraft((current) =>
      current
        .filter((step) => step.seq !== seq)
        .map((step, index) => ({ ...step, seq: index + 1 })),
    );
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await automationRecordingService.updateSteps(recording.id, draft);
      logger.info("[browserRecordings] steps saved", {
        recording: recording.id,
        steps: draft.length,
      });
      setOpen(false);
      onSaved();
    } catch (saveError) {
      toast(
        intl.formatMessage(
          { id: "browserRecordings.stepsSaveFailed" },
          { message: toMessage(saveError) },
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
        aria-label={intl.formatMessage({ id: "browserRecordings.stepsEdit" })}
        onClick={handleOpen}
      >
        <ListOrdered className="size-4" aria-hidden="true" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl gap-3">
          <DialogHeader>
            <DialogTitle>{intl.formatMessage({ id: "browserRecordings.stepsTitle" })}</DialogTitle>
            <DialogDescription>
              {intl.formatMessage({ id: "browserRecordings.stepsDescription" })}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] space-y-2 overflow-y-auto">
            {draft.map((step) => (
              <div key={step.seq} className="flex items-center gap-2">
                <span className="w-8 shrink-0 text-ui-xs text-foreground-subtle">{step.seq}</span>
                <span className="w-16 shrink-0 text-ui-xs font-medium">{step.action}</span>
                {isValueEditable(step) ? (
                  <Input
                    className="min-w-0 flex-1"
                    value={step.value ?? ""}
                    onChange={(event) => handleValueChange(step.seq, event.target.value)}
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtle">
                    {summarizeStep(step)}
                  </span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={intl.formatMessage({ id: "common.delete" })}
                  onClick={() => handleDelete(step.seq)}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <Button type="button" onClick={() => void handleSave()} disabled={saving}>
              {intl.formatMessage({ id: "browserRecordings.stepsSave" })}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
