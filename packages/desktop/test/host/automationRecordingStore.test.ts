// A5 录制件存储层单测（specs/record-replay.md）：读写/原子写/损坏拒绝/路径注入防护。
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AutomationRecordingStep } from "@zcode/shared";
import { createAutomationRecordingStore } from "../../src/host/automationRecordingStore.js";

function makeSteps(): AutomationRecordingStep[] {
  return [
    { seq: 1, action: "navigate", value: "https://example.test/" },
    { seq: 2, action: "click", target: { kind: "selector", selector: "#submit" } },
    { seq: 3, action: "wait", durationMs: 200 },
  ];
}

async function makeStore() {
  const rootDir = await mkdtemp(join(tmpdir(), "zcode-automation-recording-"));
  const store = createAutomationRecordingStore({
    rootDir,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    newId: () => "rec-fixed-id",
  });
  return { rootDir, store };
}

test("save 写入录制件文件并可通过 list/get 读回", async () => {
  const { rootDir, store } = await makeStore();
  const saved = await store.save({ title: "登录流程", steps: makeSteps() });
  assert.equal(saved.id, "rec-fixed-id");
  assert.equal(saved.source, "browser");
  assert.equal(saved.createdAt, "2026-01-01T00:00:00.000Z");

  const raw = JSON.parse(await readFile(join(rootDir, "rec-fixed-id.json"), "utf8"));
  assert.equal(raw.id, saved.id);
  assert.equal(raw.steps.length, 3);

  const { recordings, failures } = await store.list();
  assert.equal(failures.length, 0);
  assert.equal(recordings.length, 1);
  assert.equal(recordings[0]?.id, saved.id);

  const loaded = await store.get(saved.id);
  assert.deepEqual(loaded.steps, saved.steps);
  await rm(rootDir, { recursive: true, force: true });
});

test("save 原子写：目录内不残留 staging 临时文件", async () => {
  const { rootDir, store } = await makeStore();
  await store.save({ steps: makeSteps() });
  const entries = await readdir(rootDir);
  assert.equal(entries.filter((entry) => entry.includes(".tmp")).length, 0);
  assert.ok(entries.includes("rec-fixed-id.json"));
  await rm(rootDir, { recursive: true, force: true });
});

test("损坏录制文件：get 抛错且 list 记入 failures（不部分解析）", async () => {
  const { rootDir, store } = await makeStore();
  await writeFile(join(rootDir, "rec-broken.json"), "{ not valid json", "utf8");
  await assert.rejects(() => store.get("rec-broken"), /corrupt/u);
  const { recordings, failures } = await store.list();
  assert.equal(recordings.length, 0);
  assert.equal(failures.length, 1);
  assert.match(failures[0]?.error ?? "", /corrupt/u);
  await rm(rootDir, { recursive: true, force: true });
});

test("schema 不合法的录制文件同样拒绝（缺 navigate 的 value）", async () => {
  const { rootDir, store } = await makeStore();
  await writeFile(
    join(rootDir, "rec-invalid.json"),
    JSON.stringify({
      id: "rec-invalid",
      createdAt: "2026-01-01T00:00:00.000Z",
      source: "browser",
      steps: [{ seq: 1, action: "navigate" }],
    }),
    "utf8",
  );
  await assert.rejects(() => store.get("rec-invalid"), /corrupt/u);
  await rm(rootDir, { recursive: true, force: true });
});

test("get/listReports/delete 拒绝路径注入形式的 id", async () => {
  const { rootDir, store } = await makeStore();
  await assert.rejects(() => store.get("../evil"), /invalid automation recording id/u);
  await assert.rejects(() => store.listReports("../evil"), /invalid/u);
  await assert.rejects(() => store.delete("a/b"), /invalid/u);
  // 目录本身未被触碰。
  assert.equal((await readdir(rootDir)).length, 0);
  await rm(rootDir, { recursive: true, force: true });
});

test("报告与截图写入 reports/<recordingId>/ 并可按时间倒序列出", async () => {
  const { rootDir, store } = await makeStore();
  const shotPath = await store.saveScreenshot("rec-fixed-id", "run-1", 2, "aGVsbG8=");
  assert.equal(shotPath, join(rootDir, "reports", "rec-fixed-id", "run-1-step-2.png"));

  await store.saveReport({
    recordingId: "rec-fixed-id",
    runId: "run-1",
    status: "completed",
    onFailure: "abort",
    executorSurface: "fake",
    steps: [{ seq: 1, action: "navigate", status: "succeeded", elapsedMs: 5 }],
    startedAt: 1,
    finishedAt: 10,
  });
  await store.saveReport({
    recordingId: "rec-fixed-id",
    runId: "run-2",
    status: "failed",
    onFailure: "abort",
    executorSurface: "fake",
    steps: [{ seq: 1, action: "navigate", status: "failed", error: "boom", elapsedMs: 5 }],
    startedAt: 11,
    finishedAt: 20,
  });

  const reports = await store.listReports("rec-fixed-id");
  assert.deepEqual(
    reports.map((report) => report.runId),
    ["run-2", "run-1"],
  );
  const screenshot = await readFile(join(rootDir, "reports", "rec-fixed-id", "run-1-step-2.png"));
  assert.equal(screenshot.toString("utf8"), "hello");

  // delete 一并清理报告目录。
  await store.save({ steps: makeSteps() });
  assert.equal(await store.delete("rec-fixed-id"), true);
  await assert.rejects(() => readdir(join(rootDir, "reports", "rec-fixed-id")));
  // 再删返回 false（录制件本体已不存在）。
  assert.equal(await store.delete("rec-fixed-id"), false);
  await rm(rootDir, { recursive: true, force: true });
});

test("不存在/未写入的录制件 get 抛 not_found、listReports 返回空", async () => {
  const { rootDir, store } = await makeStore();
  await assert.rejects(() => store.get("rec-missing"), /not found/u);
  assert.deepEqual(await store.listReports("rec-missing"), []);
  await rm(rootDir, { recursive: true, force: true });
});
