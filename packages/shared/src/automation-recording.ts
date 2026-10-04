import { z } from "zod";

// ---- 浏览器操作录制（Record & Replay）领域类型 ----
// specs/record-replay.md：录制件存 ~/.zcode/automations/<id>.json（desktop host 存储层
// 唯一写入点）；这里只承载跨 host / services / UI 的数据契约与运行时校验，
// 与 automation-types.ts（tasks-index.sqlite 的 cron 定时任务）互不复用。

/** v1 仅浏览器来源；CUA 录制放 v2，枚举先占位避免后续破坏存储格式。 */
export const automationRecordingSourceSchema = z.enum(["browser", "cua"]);
export type AutomationRecordingSource = z.infer<typeof automationRecordingSourceSchema>;

/** 回放可派发的动作集（spec 数据模型：navigate/click/type/wait/scroll/extract）。 */
export const automationRecordingActionSchema = z.enum([
  "navigate",
  "click",
  "type",
  "wait",
  "scroll",
  "extract",
]);
export type AutomationRecordingAction = z.infer<typeof automationRecordingActionSchema>;

/**
 * 动作目标：selector（CSS/Playwright selector）或视口坐标（CSS px）。
 * discriminated union 让两种形态在运行时严格区分，不靠字符串拼接猜测。
 */
export const automationRecordingTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("selector"), selector: z.string().trim().min(1).max(2_000) }).strict(),
  z
    .object({
      kind: z.literal("point"),
      x: z.number().int(),
      y: z.number().int(),
    })
    .strict(),
]);
export type AutomationRecordingTarget = z.infer<typeof automationRecordingTargetSchema>;

/** 单步录制动作。字段按 action 约束（superRefine 收口，见 schema 尾部）。 */
export const automationRecordingStepSchema = z
  .object({
    /** >=1；回放严格按 seq 升序执行。 */
    seq: z.number().int().min(1).max(10_000),
    action: automationRecordingActionSchema,
    target: automationRecordingTargetSchema.optional(),
    /** navigate=URL；type=输入文本。 */
    value: z.string().max(100_000).optional(),
    /** wait 专用：等待毫秒（0-60000，与浏览器录制动作时长上限一致）。 */
    durationMs: z.number().int().min(0).max(60_000).optional(),
    /** scroll 专用：纵向滚动像素，负值向上。 */
    deltaY: z.number().int().min(-100_000).max(100_000).optional(),
    /** 录制期该步截图的相对路径（录制采集方写入；回放只读，不校验存在性）。 */
    screenshot: z.string().max(2_000).optional(),
    /** extract 专用：报告数据键（缺省用 seq）；其余动作忽略。 */
    label: z.string().trim().max(200).optional(),
  })
  .strict();
export type AutomationRecordingStep = z.infer<typeof automationRecordingStepSchema>;

/** 一份录制件（录制文件根 schema）。 */
export const automationRecordingSchema = z
  .object({
    /** 存储层生成；限定文件安全字符集，防止路径注入。 */
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/u, "recording id must match [A-Za-z0-9._-]"),
    title: z.string().trim().max(200).optional(),
    createdAt: z.string().datetime(),
    source: automationRecordingSourceSchema,
    /** 定时回放（v1.2）：5 段 cron（本地时区）；enabled=false 暂停。缺省不调度。 */
    schedule: z
      .object({ cronExpr: z.string().min(1).max(200), enabled: z.boolean() })
      .strict()
      .optional(),
    /** 上次回放触发时间（epoch ms）；定时回放的去重与错过判定基准。 */
    lastReplayStartedAt: z.number().int().nonnegative().optional(),
    steps: z.array(automationRecordingStepSchema).min(1).max(500),
  })
  .strict()
  .superRefine((recording, ctx) => {
    const seqs = new Set<number>();
    for (const [index, step] of recording.steps.entries()) {
      const path = ["steps", index];
      if (seqs.has(step.seq)) {
        ctx.addIssue({
          code: "custom",
          path: [...path, "seq"],
          message: `duplicate step seq ${step.seq}`,
        });
      }
      seqs.add(step.seq);
      const missing = (field: string): void =>
        ctx.addIssue({
          code: "custom",
          path: [...path, field],
          message: `action ${step.action} requires ${field}`,
        });
      switch (step.action) {
        case "navigate":
          if (!step.value) missing("value");
          break;
        case "click":
          if (!step.target) missing("target");
          break;
        case "type":
          if (!step.target || step.target.kind !== "selector") missing("target.selector");
          if (step.value === undefined) missing("value");
          break;
        case "wait":
          if (step.durationMs === undefined) missing("durationMs");
          break;
        case "scroll":
          if (step.deltaY === undefined) missing("deltaY");
          break;
        case "extract":
          // target 可选：缺省整页快照。
          break;
      }
    }
  });
export type AutomationRecording = z.infer<typeof automationRecordingSchema>;

/** 保存录制件的入参（id/createdAt 由存储层生成）。 */
export interface AutomationRecordingSaveParams {
  title?: string;
  source?: AutomationRecordingSource;
  steps: AutomationRecordingStep[];
}

// ---- 实时采集（v1.1，specs/record-replay.md）----
// 页面采集脚本回传的原始事件在 evaluate 边界进入 host：数据来自不可信页面上下文，
// 必须先过运行时校验（automationCaptureRawEventSchema），再进入步骤映射。

/**
 * 单条原始采集事件（页面采集脚本 → host drain）。
 * click：selector 为页面侧尽力构造（可缺省，回退 point 坐标），x/y 为视口 CSS px。
 * change：input/textarea/select 的提交值（含敏感文本，录制前 UI 需明示确认）。
 * scroll：页面侧已按空闲去抖聚合的纵向滚动量。
 * navigate：URL 变化（页面 popstate/hashchange 或 host URL diff 兜底）。
 */
export const automationCaptureRawEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("click"),
      ts: z.number().int().nonnegative(),
      selector: z.string().max(2_000).optional(),
      x: z.number().int(),
      y: z.number().int(),
    })
    .strict(),
  z
    .object({
      type: z.literal("change"),
      ts: z.number().int().nonnegative(),
      selector: z.string().min(1).max(2_000),
      value: z.string().max(100_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      ts: z.number().int().nonnegative(),
      deltaY: z.number().int().min(-100_000).max(100_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("navigate"),
      ts: z.number().int().nonnegative(),
      url: z.string().min(1).max(20_000),
    })
    .strict(),
]);
export type AutomationCaptureRawEvent = z.infer<typeof automationCaptureRawEventSchema>;

/** drain 返回结构（页面采集脚本一次性返回当前 URL + 已缓冲事件）。 */
export const automationCaptureDrainResultSchema = z
  .object({
    url: z.string().max(20_000),
    events: z.array(automationCaptureRawEventSchema).max(500),
  })
  .strict();
export type AutomationCaptureDrainResult = z.infer<typeof automationCaptureDrainResultSchema>;

/** 采集会话状态（服务面 getCaptureState；UI 轮询展示，非存储事实）。 */
export interface AutomationRecordingCaptureState {
  captureId: string;
  /** 采集 scope 的 sessionId（automation-record:<captureId>）。 */
  sessionId: string;
  startedAt: string;
  /** 最近一次 drain 的页面 URL；drain 尚未成功时为 null。 */
  lastUrl: string | null;
  /** 映射后的当前步骤数（随轮询推进）。 */
  stepCount: number;
  /** 已 drain 的原始事件数。 */
  eventCount: number;
}

/** startCapture 入参。 */
export interface AutomationRecordingCaptureStartParams {
  title?: string;
}

// ---- 回放报告 ----

/** 单步回放结果状态：succeeded / skipped（skip 策略跳过）/ failed。 */
export const automationReplayStepStatusSchema = z.enum(["succeeded", "skipped", "failed"]);
export type AutomationReplayStepStatus = z.infer<typeof automationReplayStepStatusSchema>;

export const automationReplayStepResultSchema = z
  .object({
    seq: z.number().int().min(1),
    action: automationRecordingActionSchema,
    status: automationReplayStepStatusSchema,
    /** 失败/跳过原因；成功时省略。 */
    error: z.string().max(2_000).optional(),
    /** 失败截图绝对路径（截图失败时省略并附 error 说明）。 */
    screenshotPath: z.string().max(2_000).optional(),
    /** extract 专用：报告数据键（缺省用 seq）。 */
    label: z.string().max(200).optional(),
    /** extract 专用：页面快照序列化数据（执行器侧已截断到上限）。 */
    data: z.string().max(32_000).optional(),
    /** 步骤执行耗时。 */
    elapsedMs: z.number().int().nonnegative(),
  })
  .strict();
export type AutomationReplayStepResult = z.infer<typeof automationReplayStepResultSchema>;

/** 整次回放的终态：completed=全部成功；failed=中断或存在失败步。 */
export const automationReplayReportStatusSchema = z.enum(["completed", "failed"]);
export type AutomationReplayReportStatus = z.infer<typeof automationReplayReportStatusSchema>;

export const automationReplayReportSchema = z
  .object({
    recordingId: z.string().min(1),
    runId: z.string().min(1),
    status: automationReplayReportStatusSchema,
    /** 失败策略（abort=失败即中断；skip=失败记 skipped 继续）。 */
    onFailure: z.enum(["abort", "skip"]),
    /** 执行面标识（如 "browser-command-bridge" / "unavailable"），用于诊断接线来源。 */
    executorSurface: z.string().min(1),
    steps: z.array(automationReplayStepResultSchema),
    startedAt: z.number().int().nonnegative(),
    finishedAt: z.number().int().nonnegative(),
    /** 整体失败原因（录制损坏、执行面不可用等未走到逐步循环的场景）。 */
    error: z.string().max(2_000).optional(),
  })
  .strict();
export type AutomationReplayReport = z.infer<typeof automationReplayReportSchema>;

/** 回放失败策略；默认 abort（失败截图+中断）。 */
export type AutomationReplayOnFailure = z.infer<typeof automationReplayReportSchema>["onFailure"];

/**
 * 解析录制文件内容。损坏（非法 JSON / schema 不通过 / 重复 seq）抛
 * Error（message 带 "corrupt"），调用方必须整体拒绝，不允许部分步骤执行。
 */
export function parseAutomationRecordingJson(text: string): AutomationRecording {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `corrupt automation recording: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const result = automationRecordingSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`corrupt automation recording: ${result.error.message}`);
  }
  return result.data;
}

/** 解析回放报告文件内容；损坏时抛 Error（message 带 "corrupt"）。 */
export function parseAutomationReplayReportJson(text: string): AutomationReplayReport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `corrupt automation replay report: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const result = automationReplayReportSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`corrupt automation replay report: ${result.error.message}`);
  }
  return result.data;
}
