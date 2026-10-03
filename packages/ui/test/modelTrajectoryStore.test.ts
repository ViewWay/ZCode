// B3 数据面（specs/smart-routing-v3.md）modelTrajectoryStore 单测。运行：
// ./node_modules/.bin/tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/modelTrajectoryStore.test.ts
// 注意：zustand getState() 是即时快照，断言前必须重新 getState()，不能缓存引用。

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  selectSmartRoutingTrail,
  useModelTrajectoryStore,
  type SmartRoutingDecisionRecord,
} from "../src/store/modelTrajectoryStore.js";

function record(seq: number, tier: "pro" | "flash" = "flash"): SmartRoutingDecisionRecord {
  return { seq, tier, note: `note-${seq}`, at: 0 };
}

function state() {
  return useModelTrajectoryStore.getState();
}

test("顺序追加；迟到/乱序/重复 seq 拒绝", () => {
  state().clearSmartRoutingTrail();
  state().recordSmartRoutingDecision("s1", record(10));
  state().recordSmartRoutingDecision("s1", record(12));
  state().recordSmartRoutingDecision("s1", record(11));
  state().recordSmartRoutingDecision("s1", record(12));
  assert.deepEqual(
    state().smartRoutingTrailBySession.s1.map((item) => item.seq),
    [10, 12],
  );
});

test("上限 100 淘汰最旧", () => {
  state().clearSmartRoutingTrail();
  for (let seq = 1; seq <= 101; seq += 1) {
    state().recordSmartRoutingDecision("s1", record(seq));
  }
  const trail = state().smartRoutingTrailBySession.s1;
  assert.equal(trail.length, 100);
  assert.equal(trail[0].seq, 2);
  assert.equal(trail[trail.length - 1].seq, 101);
});

test("clear 单 session 与全量", () => {
  state().clearSmartRoutingTrail();
  state().recordSmartRoutingDecision("s1", record(1));
  state().recordSmartRoutingDecision("s2", record(2));
  state().clearSmartRoutingTrail("s1");
  assert.equal(state().smartRoutingTrailBySession.s1, undefined);
  assert.equal(state().smartRoutingTrailBySession.s2.length, 1);
  state().clearSmartRoutingTrail();
  assert.deepEqual(state().smartRoutingTrailBySession, {});
});

test("查询面空态引用稳定", () => {
  state().clearSmartRoutingTrail();
  const emptyA = selectSmartRoutingTrail(state(), "missing");
  const emptyB = selectSmartRoutingTrail(state(), null);
  assert.equal(emptyA, emptyB);
  assert.deepEqual(emptyA, []);
});
