// A5 Host 服务单测（specs/record-replay.md）：录制件损坏时回放整体拒绝（验收场景 3），
// 以及 list/get/save/delete/replay 的服务面语义。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AutomationRecordingStep } from "@zcode/shared";
import { createAutomationRecordingHostService } from "../../src/host/automationRecordingHostService.js";
import type { BrowserActionExecutor } from "../../src/host/automationReplayExecutors.js";

function makeSteps(): AutomationRecordingStep[] {
  return [
    { seq: 1, action: "navigate", value: "https://example.test/" },
    { seq: 2, action: "wait", durationMs: 100 },
  ];
}

async function makeService(executor?: BrowserActionExecutor) {
  const rootDir = await mkdtemp(join(tmpdir(), "zcode-automation-host-service-"));
  // 计数执行器：验证「损坏拒绝」场景下引擎一步都没跑。
  const executed: number[] = [];
  const countingExecutor: BrowserActionExecutor = {
    surface: executor?.surface ?? "counting",
    async executeStep(step) {
      executed.push(step.seq);
      return executor ? executor.executeStep(step) : { ok: true };
    },
    async captureScreenshot() {
      return executor ? executor.captureScreenshot() : { ok: true, base64Png: "aGVsbG8=" };
    },
  };
  const service = createAutomationRecordingHostService({
    rootDir,
    executor: countingExecutor,
    newRunId: () => "run-fixed",
    delay: async () => {},
    // 测试直调 runScheduledReplayCheck；禁用自动滴答防悬挂句柄。
    scheduleTickMs: 0,
  });
  return { rootDir, service, executed };
}

test("save→get→replay→listReports 服务面闭环", async () => {
  const { rootDir, service, executed } = await makeService();
  const saved = await service.save({ title: "签到", steps: makeSteps() });
  assert.deepEqual(
    (await service.list()).map((recording) => recording.id),
    [saved.id],
  );
  assert.deepEqual((await service.get(saved.id))?.steps, saved.steps);
  assert.equal(await service.get("rec-missing"), null);

  const report = await service.replay(saved.id);
  assert.equal(report.status, "completed");
  assert.deepEqual(executed, [1]);
  assert.deepEqual(
    (await service.listReports(saved.id)).map((item) => item.runId),
    ["run-fixed"],
  );

  assert.equal(await service.delete(saved.id), true);
  assert.deepEqual(await service.list(), []);
  await rm(rootDir, { recursive: true, force: true });
});

test("录制件损坏：replay 整体拒绝且不执行任何步骤（不部分执行）", async () => {
  const { rootDir, service, executed } = await makeService();
  await writeFile(join(rootDir, "rec-broken.json"), "{ truncated json", "utf8");
  await assert.rejects(() => service.replay("rec-broken"), /corrupt/u);
  assert.deepEqual(executed, [], "corrupt recording must not execute any step");
  // get 同样暴露损坏事实，而不是静默当作不存在。
  await assert.rejects(() => service.get("rec-broken"), /corrupt/u);
  await rm(rootDir, { recursive: true, force: true });
});

test("不存在：replay 抛 not found", async () => {
  const { rootDir, service } = await makeService();
  await assert.rejects(() => service.replay("rec-missing"), /not found/u);
  await rm(rootDir, { recursive: true, force: true });
});

test("rootDir 与 store 都缺省时装配期显式报错", () => {
  assert.throws(
    () =>
      createAutomationRecordingHostService({
        executor: {
          surface: "x",
          executeStep: async () => ({ ok: true }),
          captureScreenshot: async () => ({ ok: false }),
        },
      }),
    /requires rootDir or store/u,
  );
});

test("replay 接真实浏览器会话：acquire runId 与报告对账，步骤经会话执行器，结束后释放", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "zcode-automation-host-service-"));
  const acquiredRunIds: string[] = [];
  const sessionStepSeqs: number[] = [];
  const staticExecutorUsed: number[] = [];
  let released = false;
  const service = createAutomationRecordingHostService({
    rootDir,
    // 静态执行面不应被使用；记录调用以证明步骤走的是会话执行器。
    executor: {
      surface: "static-fallback",
      async executeStep(step) {
        staticExecutorUsed.push(step.seq);
        return { ok: true };
      },
      async captureScreenshot() {
        return { ok: true, base64Png: "" };
      },
    },
    acquireReplayBrowserSession: async (runId) => {
      acquiredRunIds.push(runId);
      return {
        executor: {
          surface: "browser-command-bridge:automation-replay:session",
          async executeStep(step) {
            sessionStepSeqs.push(step.seq);
            return { ok: true };
          },
          async captureScreenshot() {
            return { ok: true, base64Png: "aGVsbG8=" };
          },
        },
        release: async () => {
          released = true;
        },
      };
    },
    newRunId: () => "run-live",
    delay: async () => {},
  });
  const saved = await service.save({ title: "live", steps: makeSteps() });
  const report = await service.replay(saved.id);
  assert.equal(report.status, "completed");
  assert.equal(report.executorSurface, "browser-command-bridge:automation-replay:session");
  assert.deepEqual(acquiredRunIds, ["run-live"]);
  assert.equal(report.runId, "run-live");
  assert.deepEqual(sessionStepSeqs, [1]);
  assert.deepEqual(staticExecutorUsed, [], "steps must run via session executor");
  assert.equal(released, true, "session must be released after replay");
  await rm(rootDir, { recursive: true, force: true });
});

test("会话获取失败：回退 unavailable 执行面，报告 executorSurface 说明原因且状态 failed", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "zcode-automation-host-service-"));
  const service = createAutomationRecordingHostService({
    rootDir,
    executor: {
      surface: "static-fallback",
      async executeStep() {
        return { ok: true };
      },
      async captureScreenshot() {
        return { ok: false };
      },
    },
    acquireReplayBrowserSession: async () => {
      throw new Error("replay browser session preflight failed: backend_unavailable: down");
    },
    delay: async () => {},
  });
  const saved = await service.save({ title: "broken", steps: makeSteps() });
  const report = await service.replay(saved.id);
  assert.equal(report.status, "failed");
  assert.match(
    report.executorSurface,
    /^unavailable: replay browser session acquisition failed: /u,
  );
  // 步骤以 unavailable 失败，绝不伪造成功。
  assert.equal(report.steps[0]?.status, "failed");
  assert.match(report.steps[0]?.error ?? "", /unavailable/u);
  await rm(rootDir, { recursive: true, force: true });
});

test("步骤失败（abort）也释放会话：release 在 finally 中执行", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "zcode-automation-host-service-"));
  let released = false;
  const service = createAutomationRecordingHostService({
    rootDir,
    executor: {
      surface: "static-fallback",
      async executeStep() {
        return { ok: true };
      },
      async captureScreenshot() {
        return { ok: false };
      },
    },
    acquireReplayBrowserSession: async () => ({
      executor: {
        surface: "failing-session",
        async executeStep() {
          return { ok: false, error: "selector_not_found: #gone" };
        },
        async captureScreenshot() {
          return { ok: false, error: "unavailable" };
        },
      },
      release: async () => {
        released = true;
      },
    }),
    delay: async () => {},
  });
  const saved = await service.save({
    title: "fail",
    steps: [
      { seq: 1, action: "navigate", value: "https://example.test/" },
      { seq: 2, action: "extract" },
    ],
  });
  const report = await service.replay(saved.id);
  assert.equal(report.status, "failed");
  // abort 策略：第二步不执行。
  assert.deepEqual(
    report.steps.map((step) => step.seq),
    [1],
  );
  assert.equal(released, true, "session must be released even when replay failed");
  await rm(rootDir, { recursive: true, force: true });
});

// ---- 实时采集服务面（v1.1，specs/record-replay.md）----

/** 可脚本化的 fake 采集会话：stop 返回注入步骤；记录 stop/cancel 调用。 */
function makeFakeCaptureHandle(options?: {
  steps?: AutomationRecordingStep[];
  failStop?: boolean;
}) {
  const calls: string[] = [];
  return {
    calls,
    captureId: "cap-fake",
    sessionId: "automation-record:cap-fake",
    state: () => ({
      captureId: "cap-fake",
      sessionId: "automation-record:cap-fake",
      startedAt: "2026-10-03T00:00:00.000Z",
      lastUrl: "https://example.test/",
      stepCount: options?.steps?.length ?? 0,
      eventCount: options?.steps?.length ?? 0,
    }),
    stop: async (): Promise<AutomationRecordingStep[]> => {
      calls.push("stop");
      if (options?.failStop) throw new Error("drain channel broken");
      return options?.steps ?? [];
    },
    cancel: async (): Promise<void> => {
      calls.push("cancel");
    },
  };
}

async function makeCaptureService(handle?: Awaited<ReturnType<typeof makeFakeCaptureHandle>>) {
  const rootDir = await mkdtemp(join(tmpdir(), "zcode-automation-capture-service-"));
  let created = 0;
  const service = createAutomationRecordingHostService({
    rootDir,
    createCaptureSession: async () => {
      created += 1;
      if (!handle) throw new Error("capture browser session preflight failed: down");
      return handle;
    },
    executor: {
      surface: "unused",
      executeStep: async () => ({ ok: true }),
      captureScreenshot: async () => ({ ok: false }),
    },
    delay: async () => {},
  });
  return { rootDir, service, createdCount: () => created };
}

test("startCapture→getCaptureState→stopCapture：步骤落库并出现在列表", async () => {
  const handle = makeFakeCaptureHandle({
    steps: [
      { seq: 1, action: "navigate", value: "https://example.test/" },
      { seq: 2, action: "click", target: { kind: "selector", selector: "#go" } },
    ],
  });
  const { rootDir, service } = await makeCaptureService(handle);
  const state = await service.startCapture({ title: "采集" });
  assert.equal(state.captureId, "cap-fake");
  assert.equal((await service.getCaptureState())?.captureId, "cap-fake");
  const recording = await service.stopCapture();
  assert.equal(recording.title, "采集");
  assert.equal(recording.source, "browser");
  assert.deepEqual(
    (await service.list()).map((item) => item.id),
    [recording.id],
  );
  // 停止后无活动会话。
  assert.equal(await service.getCaptureState(), null);
  await rm(rootDir, { recursive: true, force: true });
});

test("未装配采集面/已有活动会话时 startCapture 诚实拒绝", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "zcode-automation-capture-service-"));
  const service = createAutomationRecordingHostService({
    rootDir,
    executor: {
      surface: "unused",
      executeStep: async () => ({ ok: true }),
      captureScreenshot: async () => ({ ok: false }),
    },
    delay: async () => {},
  });
  await assert.rejects(() => service.startCapture(), /unavailable in this host/u);
  await rm(rootDir, { recursive: true, force: true });

  const handle = makeFakeCaptureHandle({ steps: makeSteps() });
  const wired = await makeCaptureService(handle);
  await wired.service.startCapture();
  await assert.rejects(() => wired.service.startCapture(), /already running/u);
  await wired.service.cancelCapture();
  await rm(wired.rootDir, { recursive: true, force: true });
});

test("stopCapture 空步骤拒绝保存且不留活动会话", async () => {
  const handle = makeFakeCaptureHandle({ steps: [] });
  const { rootDir, service } = await makeCaptureService(handle);
  await service.startCapture();
  await assert.rejects(() => service.stopCapture(), /no steps captured/u);
  assert.equal(await service.getCaptureState(), null);
  assert.deepEqual(await service.list(), []);
  await rm(rootDir, { recursive: true, force: true });
});

test("cancelCapture 丢弃不落库；stop/cancel 在无活动会话时抛错", async () => {
  const handle = makeFakeCaptureHandle({ steps: makeSteps() });
  const { rootDir, service } = await makeCaptureService(handle);
  await service.startCapture();
  assert.equal(await service.cancelCapture(), true);
  assert.deepEqual(handle.calls, ["cancel"]);
  assert.deepEqual(await service.list(), []);
  await assert.rejects(() => service.stopCapture(), /no active/u);
  await assert.rejects(() => service.cancelCapture(), /no active/u);
  await rm(rootDir, { recursive: true, force: true });
});

test("stopCapture 会话失败：错误透出且活动占用已摘除（可重新开始）", async () => {
  const handle = makeFakeCaptureHandle({ failStop: true });
  const { rootDir, service, createdCount } = await makeCaptureService(handle);
  await service.startCapture();
  await assert.rejects(() => service.stopCapture(), /drain channel broken/u);
  assert.equal(await service.getCaptureState(), null);
  assert.equal(createdCount(), 1);
  await rm(rootDir, { recursive: true, force: true });
});

test("setSchedule：非法 cron 拒绝；合法写入/暂停/清除", async () => {
  const { rootDir, service } = await makeService();
  const saved = await service.save({ title: "签到", steps: makeSteps() });
  await assert.rejects(
    () => service.setSchedule(saved.id, { cronExpr: "not-a-cron", enabled: true }),
    /invalid cron/u,
  );
  const enabled = await service.setSchedule(saved.id, { cronExpr: "0 * * * *", enabled: true });
  assert.deepEqual(enabled.schedule, { cronExpr: "0 * * * *", enabled: true });
  const paused = await service.setSchedule(saved.id, { cronExpr: "0 * * * *", enabled: false });
  assert.equal(paused.schedule?.enabled, false);
  const cleared = await service.setSchedule(saved.id, undefined);
  assert.equal(cleared.schedule, undefined);
  await rm(rootDir, { recursive: true, force: true });
});

test("定时回放：到期触发、写 lastReplayStartedAt 并产出报告", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "zcode-automation-sched-"));
  const executed: number[] = [];
  const service = createAutomationRecordingHostService({
    rootDir,
    executor: {
      surface: "counting",
      async executeStep(step) {
        executed.push(step.seq);
        return { ok: true };
      },
      async captureScreenshot() {
        return { ok: true, base64Png: "aGVsbG8=" };
      },
    },
    scheduleTickMs: 0,
    now: () => 1_000_000,
    // next=900_000 < now=1_000_000 → 立即到期。
    computeNextRunAtFn: () => 900_000,
    newRunId: () => "run-sched",
    delay: async () => {},
  });
  const saved = await service.save({ title: "巡检", steps: makeSteps() });
  await service.setSchedule(saved.id, { cronExpr: "0 * * * *", enabled: true });
  await service.runScheduledReplayCheck();
  const after = await service.get(saved.id);
  assert.equal(after?.lastReplayStartedAt, 1_000_000);
  assert.equal((await service.listReports(saved.id)).length, 1);
  // wait 不派发执行器：只统计 navigate。
  assert.deepEqual(executed, [1]);
  await rm(rootDir, { recursive: true, force: true });
});

test("定时回放：未到期不触发", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "zcode-automation-sched-not-due-"));
  const service = createAutomationRecordingHostService({
    rootDir,
    scheduleTickMs: 0,
    now: () => 1_000_000,
    computeNextRunAtFn: () => 2_000_000,
    delay: async () => {},
  });
  const saved = await service.save({ title: "巡检", steps: makeSteps() });
  await service.setSchedule(saved.id, { cronExpr: "0 * * * *", enabled: true });
  await service.runScheduledReplayCheck();
  const after = await service.get(saved.id);
  assert.equal(after?.lastReplayStartedAt, undefined);
  assert.equal((await service.listReports(saved.id)).length, 0);
  await rm(rootDir, { recursive: true, force: true });
});

test("updateSteps：整组替换并重排 seq；断档可读拒绝", async () => {
  const { rootDir, service } = await makeService();
  const saved = await service.save({ title: "巡检", steps: makeSteps() });
  // 编辑器删除首步 → 剩余步骤重排为 1。
  const updated = await service.updateSteps(saved.id, [
    { seq: 1, action: "wait", durationMs: 250 },
  ]);
  assert.equal(updated.steps.length, 1);
  assert.equal(updated.steps[0]?.seq, 1);
  // seq 重复 → schema superRefine 可读拒绝（编辑器删除时已自动重排，重复只可能来自
  // 非法直调；断档是合法设计——引擎按 seq 升序执行、不要求 1..N 连续）。
  await assert.rejects(
    () =>
      service.updateSteps(saved.id, [
        { seq: 1, action: "wait", durationMs: 100 },
        { seq: 1, action: "navigate", value: "https://example.test/" },
      ]),
    /seq/u,
  );
  await rm(rootDir, { recursive: true, force: true });
});
