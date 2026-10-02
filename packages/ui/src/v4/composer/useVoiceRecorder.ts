// 麦克风采集 hook（specs/voice-pipeline.md 目标 3）：只负责 getUserMedia +
// MediaRecorder 采集与生命周期，落盘与附件注入由 VoiceRecorderControl 收口。
// 失败路径 fail-closed：错误归类后交给 UI 渲染，绝不静默重试。
import { useCallback, useEffect, useRef, useState } from "react";
import { logger } from "@/logger.js";
import {
  VOICE_RECORDING_MAX_DURATION_MS,
  isVoiceRecordingSupported,
  pickVoiceRecordingMimeType,
  resolveVoiceRecordingErrorKind,
  type VoiceRecordingErrorKind,
} from "@/lib/voiceRecording.js";

export type VoiceRecorderStatus = "idle" | "recording";

export interface VoiceRecorderResult {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

interface UseVoiceRecorderOptions {
  /** 录音结束（手动停止或到时自动停止）统一回调；组件据此落盘并注入附件。 */
  onRecordingFinished: (result: VoiceRecorderResult) => void;
}

/**
 * 单实例录音状态机：idle ⇄ recording。
 * - start：请求麦克风；权限拒绝/无设备/占用时停在 idle 并暴露 errorKind。
 * - stop：正常收尾，产出 { blob, mimeType, durationMs } 交给 onRecordingFinished。
 * - 超过 VOICE_RECORDING_MAX_DURATION_MS 自动走 stop，防忘关麦。
 * - 卸载时直接释放轨道，不触发回调（避免 unmounted setState）。
 */
export function useVoiceRecorder(options: UseVoiceRecorderOptions) {
  const { onRecordingFinished } = options;
  const [status, setStatus] = useState<VoiceRecorderStatus>("idle");
  const [errorKind, setErrorKind] = useState<VoiceRecordingErrorKind | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef<string>("");
  const startedAtRef = useRef<number>(0);
  const elapsedTimerRef = useRef<number | null>(null);
  const maxDurationTimerRef = useRef<number | null>(null);
  const finishedRef = useRef(options.onRecordingFinished);
  const disposedRef = useRef(false);
  // 一次采集从 getUserMedia 发起持续到轨道释放；用它挡「授权弹窗期间二次点击」的
  // 双重启动（state 更新是异步的，仅靠 status 闭包判断挡不住连点竞态）。
  const activeRef = useRef(false);
  // stop 在 onstop 回调前可能被重复触发（按钮连点/自动到时与手动停止竞态），只结算一次。
  const finalizingRef = useRef(false);
  const stopRef = useRef<() => void>(() => {});

  finishedRef.current = onRecordingFinished;

  const releaseCapture = useCallback(() => {
    if (elapsedTimerRef.current !== null) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    if (maxDurationTimerRef.current !== null) {
      window.clearTimeout(maxDurationTimerRef.current);
      maxDurationTimerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    finalizingRef.current = false;
    activeRef.current = false;
  }, []);

  const finalizeRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || finalizingRef.current) return;
    finalizingRef.current = true;
    const mimeType = mimeTypeRef.current;
    const chunks = chunksRef.current;
    const durationMs = Date.now() - startedAtRef.current;
    const handleStopped = () => {
      releaseCapture();
      setStatus("idle");
      setElapsedMs(0);
      if (disposedRef.current) return;
      const blob = new Blob(chunks, { type: mimeType });
      if (blob.size === 0) {
        // 极短录音或被系统打断时 chunks 为空：归类 empty，不产出空附件。
        setErrorKind("empty");
        return;
      }
      finishedRef.current({ blob, mimeType, durationMs });
    };
    if (recorder.state === "inactive") {
      handleStopped();
      return;
    }
    recorder.addEventListener("stop", handleStopped, { once: true });
    recorder.stop();
  }, [releaseCapture]);

  stopRef.current = finalizeRecording;

  const start = useCallback(() => {
    if (status !== "idle" || activeRef.current) return;
    setErrorKind(null);
    if (!isVoiceRecordingSupported()) {
      // 入口已按能力门控，这里兜底非标准环境（如 iframe 权限策略变化）。
      setErrorKind("unsupported");
      return;
    }
    const mimeType = pickVoiceRecordingMimeType();
    if (!mimeType) {
      setErrorKind("unsupported");
      return;
    }
    activeRef.current = true;
    const mediaDevices = navigator.mediaDevices;
    void mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        if (disposedRef.current || recorderRef.current) {
          // 等待授权期间组件已卸载/已有采集：立即释放，不留悬挂轨道。
          stream.getTracks().forEach((track) => track.stop());
          if (!recorderRef.current) activeRef.current = false;
          return;
        }
        const recorder = new MediaRecorder(stream, { mimeType });
        streamRef.current = stream;
        recorderRef.current = recorder;
        chunksRef.current = [];
        mimeTypeRef.current = mimeType;
        startedAtRef.current = Date.now();
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        });
        recorder.addEventListener("error", (event) => {
          logger.warn("[voice-recorder] MediaRecorder error", event);
          finalizeRecording();
        });
        recorder.start(1000);
        setStatus("recording");
        setElapsedMs(0);
        elapsedTimerRef.current = window.setInterval(() => {
          setElapsedMs(Date.now() - startedAtRef.current);
        }, 250);
        maxDurationTimerRef.current = window.setTimeout(() => {
          stopRef.current();
        }, VOICE_RECORDING_MAX_DURATION_MS);
      })
      .catch((error: unknown) => {
        activeRef.current = false;
        if (disposedRef.current) return;
        const kind = resolveVoiceRecordingErrorKind(error);
        setErrorKind(kind);
        logger.warn("[voice-recorder] getUserMedia failed", { kind, error });
      });
  }, [finalizeRecording, status]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      releaseCapture();
    };
  }, [releaseCapture]);

  const dismissError = useCallback(() => {
    setErrorKind(null);
  }, []);

  return {
    status,
    errorKind,
    elapsedMs,
    start,
    stop: finalizeRecording,
    dismissError,
  };
}
