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
