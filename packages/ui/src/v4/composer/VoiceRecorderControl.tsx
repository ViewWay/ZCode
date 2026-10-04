// 输入区语音录音入口（specs/voice-pipeline.md 目标 3）：
// 采集（useVoiceRecorder）→ base64 → IPlatformService.createTempVoiceAttachment
// 落盘为宿主本地音频文件 → 作为 localPath 附件交给 composer，模型用
// asr_transcribe 工具转写。无 getUserMedia/无平台通道时整个入口隐藏（Web 降级）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MicIcon, SquareIcon } from "lucide-react";
import { toast } from "@/components/ui/toast.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { ChatComposerAttachment } from "@/lib/chatAttachments.js";
import {
  VOICE_RECORDING_MAX_BYTES,
  buildVoiceRecordingFilename,
  createVoiceRecordingComposerAttachment,
  encodeVoiceRecordingBlob,
  isVoiceRecordingSupported,
} from "@/lib/voiceRecording.js";
import { useVoiceRecorder } from "@/v4/composer/useVoiceRecorder.js";

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function VoiceRecorderControl({
  disabled = false,
  onRecordingSaved,
}: {
  disabled?: boolean;
  /** 录音落盘成功后注入 composer 附件（走 useComposerAttachments 的统一上传/上限通道）。 */
  onRecordingSaved: (attachment: ChatComposerAttachment) => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // 能力门控只做一次：无 getUserMedia/MediaRecorder 或无宿主落盘通道（Web）时隐藏入口。
  const supported = useMemo(
    () => isVoiceRecordingSupported() && Boolean(platform.createTempVoiceAttachment),
    [platform],
  );

  const handleRecordingFinished = useCallback(
    async ({ blob, mimeType }: { blob: Blob; mimeType: string }) => {
      const createTempVoiceAttachment = platform.createTempVoiceAttachment;
      if (!createTempVoiceAttachment || savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      try {
        // 超限在编码前拦截，避免白编码 32MiB base64 后才被宿主拒绝。
        if (blob.size > VOICE_RECORDING_MAX_BYTES) {
          toast(intl.formatMessage({ id: "chat.composer.voiceRecording.error.too-large" }), {
            variant: "warning",
            position: "bottom-center",
          });
          return;
        }
        const dataBase64 = await encodeVoiceRecordingBlob(blob);
        const saved = await createTempVoiceAttachment({
          dataBase64,
          mimeType,
          filename: buildVoiceRecordingFilename(mimeType),
        });
        onRecordingSaved(createVoiceRecordingComposerAttachment(saved));
        // 提示词引导：录完即可直接发送让模型转写（asr_transcribe）。
        toast(
          intl.formatMessage(
            { id: "chat.composer.voiceRecording.saved" },
            { filename: saved.filename },
          ),
          { position: "bottom-center" },
        );
      } catch (error) {
        logger.warn("[voice-recorder] save recording failed", error);
        toast(
          intl.formatMessage(
            { id: "chat.composer.voiceRecording.saveFailed" },
            { message: error instanceof Error ? error.message : String(error) },
          ),
          { variant: "warning", position: "bottom-center" },
        );
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [intl, onRecordingSaved, platform],
  );

  const recorder = useVoiceRecorder({
    onRecordingFinished: ({ blob, mimeType }) => {
      void handleRecordingFinished({ blob, mimeType });
    },
  });

  const showError = useCallback(
    (kind: NonNullable<typeof recorder.errorKind>) => {
      toast(intl.formatMessage({ id: `chat.composer.voiceRecording.error.${kind}` }), {
        variant: "warning",
        position: "bottom-center",
      });
      recorder.dismissError();
    },
    [intl, recorder],
  );

  // 采集层错误（权限拒绝等）到达时统一 toast；在 effect 中触发，不在渲染期做副作用。
  useEffect(() => {
    if (recorder.errorKind) showError(recorder.errorKind);
  }, [recorder.errorKind, showError]);

  if (!supported) return null;

  const isRecording = recorder.status === "recording";
  const label = isRecording
    ? intl.formatMessage({ id: "chat.composer.voiceRecording.stopTooltip" })
    : saving
      ? intl.formatMessage({ id: "chat.composer.voiceRecording.savingTooltip" })
      : intl.formatMessage({ id: "chat.composer.voiceRecording.tooltip" });

  return (
    <div className="flex shrink-0 items-center gap-1.5" data-composer-voice-recorder>
      <ControlHintTooltip title={label}>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          className="gap-1 rounded-lg text-ui-base"
          onClick={() => {
            if (saving) return;
            if (isRecording) {
              recorder.stop();
              return;
            }
            recorder.start();
          }}
          disabled={disabled || saving}
          aria-label={label}
          data-testid="chat-voice-recording-button"
          data-recording={isRecording ? "true" : undefined}
        >
          {isRecording ? (
            <SquareIcon className="size-4 text-destructive" />
          ) : saving ? (
            <Spinner className="size-4" />
          ) : (
            <MicIcon className="size-4" />
          )}
          <span className="sr-only">{label}</span>
        </Button>
      </ControlHintTooltip>
      {isRecording ? (
        <span className="flex items-center gap-1.5 text-ui-sm text-foreground-subtle">
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden />
          <span className="font-mono tabular-nums" aria-live="polite">
            {formatElapsed(recorder.elapsedMs)}
          </span>
        </span>
      ) : null}
    </div>
  );
}
