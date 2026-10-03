// Smart v2 套餐路由端口单测：阈值直选 / 自动用最早过期重置卡 / 候选切换 / 未登录跳过 /
// 回落 v1 目录择优 / note 内容。全部走最小 fake（目录快照 + 额度数据面），不启动协议 server。

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProviderRegistryView } from "@zcode/provider";
import {
  SMART_ROUTING_LOW_QUOTA_THRESHOLD,
  SMART_TIER_COMPLEX_CONTEXT_MESSAGES,
  SMART_TIER_COMPLEX_TURN_INDEX,
  createSmartRoutingPort,
  type SmartRoutingCatalogEntry,
  type SmartRoutingPlanSnapshot,
  type SmartRoutingResetCard,
  type SmartRoutingUsageStats,
} from "../src/zcode-protocol/smart-routing-port.js";

interface FakeUsageStatsCalls {
  snapshotCalls: Array<{ providerId: string }>;
  resetCardCalls: Array<{ providerId: string }>;
  useCalls: Array<{ providerId: string; resetType: "FIVE_HOUR" | "WEEK"; idempotencyKey: string }>;
}

interface FakeUsageStatsInput {
  /** 按 providerId 返回额度快照；数组按调用次序依次消耗（用于「重置前后」两次读取）。 */
  snapshots: Record<string, SmartRoutingPlanSnapshot[] | SmartRoutingPlanSnapshot>;
  cards?: Record<string, SmartRoutingResetCard[]>;
  /** 按 providerId 决定核销结果；缺省 used:true。 */
  useResults?: Record<string, { used: boolean } | Error>;
  /** 按 providerId 让额度查询直接抛错。 */
  snapshotErrors?: Record<string, Error>;
}

function fakeUsageStats(input: FakeUsageStatsInput): SmartRoutingUsageStats & {
  calls: FakeUsageStatsCalls;
} {
  const calls: FakeUsageStatsCalls = { snapshotCalls: [], resetCardCalls: [], useCalls: [] };
  const counters = new Map<string, number>();
  return {
    calls,
    async getPlanUsageSnapshot(providerId) {
      calls.snapshotCalls.push({ providerId });
      if (input.snapshotErrors?.[providerId]) throw input.snapshotErrors[providerId];
      const configured = input.snapshots[providerId];
      if (!configured) throw new Error(`no snapshot configured for ${providerId}`);
      if (Array.isArray(configured)) {
        const index = counters.get(`snapshot:${providerId}`) ?? 0;
        counters.set(`snapshot:${providerId}`, index + 1);
        return configured[Math.min(index, configured.length - 1)]!;
      }
      return configured;
    },
    async getResetCards(providerId) {
      calls.resetCardCalls.push({ providerId });
      return input.cards?.[providerId] ?? [];
    },
    async useResetCard(useInput) {
      calls.useCalls.push({
        providerId: useInput.providerId,
        resetType: useInput.resetType,
        idempotencyKey: useInput.idempotencyKey,
      });
      const configured = input.useResults?.[useInput.providerId];
      if (configured instanceof Error) throw configured;
      return configured ?? { used: true };
    },
  };
}

function planEntry(
  providerId: string,
  models: ReadonlyArray<readonly [string, number]>,
  extra: Partial<SmartRoutingCatalogEntry> = {},
): SmartRoutingCatalogEntry {
  return {
    providerId,
    kind: "account-plan",
    usable: true,
    models: models.map(([modelId, contextWindow]) => ({ modelId, contextWindow })),
    ...extra,
  };
}

function registryViewWithOrdinary(
  providerId: string,
  modelId: string,
  contextWindow: number,
): ProviderRegistryView {
  return {
    revision: 1,
    providers: [
      {
        providerId,
        providerName: providerId,
        templateId: `${providerId}-template`,
        config: { visibility: "visible" },
        models: [{ modelId, config: { properties: { contextWindow } } }],
      },
    ],
  } as unknown as ProviderRegistryView;
}

const FIXED_NOW = Date.parse("2026-10-02T10:00:00.000Z");

function fixedClock(): number {
  return FIXED_NOW;
}

test("剩余额度不低于阈值时直选该套餐的最大上下文模型", async () => {
  const usageStats = fakeUsageStats({
    snapshots: { bigmodel: { state: "authenticated", remainingPercentage: 0.42 } },
  });
  const port = createSmartRoutingPort({
    usageStats,
    getCatalog: () => [
      planEntry("bigmodel", [
        ["glm-4.7-flash", 128_000],
        ["glm-4.7", 200_000],
      ]),
    ],
    getRegistryView: () => registryViewWithOrdinary("openai", "gpt-x", 100_000),
    now: fixedClock,
  });
  const decision = await port.getRoutingDecision();
  assert.equal(decision.kind, "plan");
  assert.equal(decision.providerId, "bigmodel");
  assert.equal(decision.modelId, "glm-4.7");
  assert.match(decision.note, /bigmodel\/glm-4\.7/);
  assert.match(decision.note, /42%/u);
  assert.match(decision.note, /5%/u);
  assert.deepEqual(usageStats.calls.resetCardCalls, []);
  assert.deepEqual(usageStats.calls.useCalls, []);
});

test("剩余低于阈值且有未过期重置卡时自动核销最早过期的卡并选该套餐", async () => {
  const usageStats = fakeUsageStats({
    snapshots: {
      bigmodel: [
        { state: "authenticated", remainingPercentage: 0.03 },
        { state: "authenticated", remainingPercentage: 0.9 },
      ],
    },
    cards: {
      bigmodel: [
        { resetType: "WEEK", expireAt: FIXED_NOW + 2 * 60 * 60 * 1000 },
        { resetType: "FIVE_HOUR", expireAt: FIXED_NOW + 60 * 60 * 1000 },
        { resetType: "FIVE_HOUR", expireAt: FIXED_NOW - 1000 },
      ],
    },
  });
  const port = createSmartRoutingPort({
    usageStats,
    getCatalog: () => [planEntry("bigmodel", [["glm-4.7", 200_000]])],
    getRegistryView: () => registryViewWithOrdinary("openai", "gpt-x", 100_000),
    now: fixedClock,
  });
  const decision = await port.getRoutingDecision();
  assert.equal(decision.kind, "plan");
  assert.equal(decision.providerId, "bigmodel");
  assert.equal(decision.modelId, "glm-4.7");
  assert.match(decision.note, /重置卡/u);
  assert.match(decision.note, /FIVE_HOUR/u);
  assert.match(decision.note, /90%/u);
  // 只核销一张卡：最早过期且未过期的 FIVE_HOUR（过期的 FIVE_HOUR 与较晚的 WEEK 都不用）。
  assert.equal(usageStats.calls.useCalls.length, 1);
  assert.equal(usageStats.calls.useCalls[0]!.resetType, "FIVE_HOUR");
  assert.match(usageStats.calls.useCalls[0]!.idempotencyKey, /^smart-routing:/u);
});

test("剩余低于阈值且无未过期重置卡时切换下一个候选", async () => {
  const usageStats = fakeUsageStats({
    snapshots: {
      bigmodel: { state: "authenticated", remainingPercentage: 0.03 },
      zai: { state: "authenticated", remainingPercentage: 0.5 },
    },
    cards: { bigmodel: [] },
  });
  const port = createSmartRoutingPort({
    usageStats,
    getCatalog: () => [
      planEntry("bigmodel", [["glm-4.7", 200_000]]),
      planEntry("zai", [["glm-4.7-plus", 200_000]]),
    ],
    getRegistryView: () => registryViewWithOrdinary("openai", "gpt-x", 100_000),
    now: fixedClock,
  });
  const decision = await port.getRoutingDecision();
  assert.equal(decision.kind, "plan");
  assert.equal(decision.providerId, "zai");
  assert.equal(decision.modelId, "glm-4.7-plus");
  assert.deepEqual(usageStats.calls.useCalls, []);
});

test("全部套餐不可用时回落 v1 目录择优并携带择优结果", async () => {
  const usageStats = fakeUsageStats({
    snapshots: {
      bigmodel: { state: "authenticated", remainingPercentage: 0.03 },
      zai: { state: "authenticated", remainingPercentage: 0.02 },
    },
    cards: { bigmodel: [], zai: [{ resetType: "FIVE_HOUR", expireAt: FIXED_NOW - 1000 }] },
  });
  const port = createSmartRoutingPort({
    usageStats,
    getCatalog: () => [
      planEntry("bigmodel", [["glm-4.7", 200_000]]),
      planEntry("zai", [["glm-4.7-plus", 200_000]]),
    ],
    getRegistryView: () => registryViewWithOrdinary("openai", "gpt-x", 100_000),
    now: fixedClock,
  });
  const decision = await port.getRoutingDecision();
  assert.equal(decision.kind, "catalog");
  assert.equal(decision.providerId, "openai");
  assert.equal(decision.modelId, "gpt-x");
  assert.match(decision.note, /回落普通目录择优 openai\/gpt-x/u);
  assert.match(decision.note, /bigmodel/u);
  assert.match(decision.note, /zai/u);
});

test("未登录（非 current/不可用）的套餐 provider 被跳过，不进入额度查询", async () => {
  const usageStats = fakeUsageStats({ snapshots: {} });
  const port = createSmartRoutingPort({
    usageStats,
    getCatalog: () => [
      planEntry("bigmodel", [["glm-4.7", 200_000]], { usable: false }),
      planEntry("zai", [["glm-4.7-plus", 200_000]], {
        kind: "account-plan",
        usable: false,
      }),
    ],
    getRegistryView: () => registryViewWithOrdinary("openai", "gpt-x", 100_000),
    now: fixedClock,
  });
  const decision = await port.getRoutingDecision();
  assert.equal(decision.kind, "catalog");
  assert.equal(decision.providerId, "openai");
  assert.deepEqual(usageStats.calls.snapshotCalls, []);
});

test("无已登录套餐且目录也为空时返回 unavailable", async () => {
  const usageStats = fakeUsageStats({ snapshots: {} });
  const port = createSmartRoutingPort({
    usageStats,
    getCatalog: () => [],
    getRegistryView: () => ({ revision: 1, providers: [] }),
    now: fixedClock,
  });
  const decision = await port.getRoutingDecision();
  assert.equal(decision.kind, "unavailable");
  assert.match(decision.note, /无已登录套餐/u);
});

test("可用的闲时套餐排在付费套餐之前（时间窗能力的临时近似）", async () => {
  const usageStats = fakeUsageStats({
    snapshots: {
      "zai-offpeak": { state: "authenticated", remainingPercentage: 0.6 },
      bigmodel: { state: "authenticated", remainingPercentage: 0.8 },
    },
  });
  const port = createSmartRoutingPort({
    usageStats,
    getCatalog: () => [
      planEntry("bigmodel", [["glm-4.7", 200_000]]),
      planEntry("zai-offpeak", [["glm-4.7-offpeak", 200_000]], {
        kind: "account-offpeak",
        usable: true,
      }),
    ],
    getRegistryView: () => registryViewWithOrdinary("openai", "gpt-x", 100_000),
    now: fixedClock,
  });
  const decision = await port.getRoutingDecision();
  assert.equal(decision.kind, "plan");
  assert.equal(decision.providerId, "zai-offpeak");
  // v2 两阶段评估：全部候选都会预取快照；顺序仍验证闲时优先。
  assert.deepEqual(
    usageStats.calls.snapshotCalls.map((call) => call.providerId),
    ["zai-offpeak", "bigmodel"],
  );
  assert.match(decision.note, /闲时/u);
});

test("重置卡核销失败不阻塞，降级为无卡路径并切换下一候选", async () => {
  const usageStats = fakeUsageStats({
    snapshots: {
      bigmodel: { state: "authenticated", remainingPercentage: 0.03 },
      zai: { state: "authenticated", remainingPercentage: 0.5 },
    },
    cards: {
      bigmodel: [{ resetType: "FIVE_HOUR", expireAt: FIXED_NOW + 60 * 60 * 1000 }],
    },
    useResults: { bigmodel: new Error("reset throttled") },
  });
  const port = createSmartRoutingPort({
    usageStats,
    getCatalog: () => [
      planEntry("bigmodel", [["glm-4.7", 200_000]]),
      planEntry("zai", [["glm-4.7-plus", 200_000]]),
    ],
    getRegistryView: () => registryViewWithOrdinary("openai", "gpt-x", 100_000),
    now: fixedClock,
  });
  const decision = await port.getRoutingDecision();
  assert.equal(decision.kind, "plan");
  assert.equal(decision.providerId, "zai");
  assert.equal(usageStats.calls.useCalls.length, 1);
});

test("核销成功但重读额度仍未达阈值时切换下一候选", async () => {
  const usageStats = fakeUsageStats({
    snapshots: {
      bigmodel: { state: "authenticated", remainingPercentage: 0.04 },
      zai: { state: "authenticated", remainingPercentage: 0.5 },
    },
    cards: {
      bigmodel: [{ resetType: "FIVE_HOUR", expireAt: FIXED_NOW + 60 * 60 * 1000 }],
    },
  });
  const port = createSmartRoutingPort({
    usageStats,
    getCatalog: () => [
      planEntry("bigmodel", [["glm-4.7", 200_000]]),
      planEntry("zai", [["glm-4.7-plus", 200_000]]),
    ],
    getRegistryView: () => registryViewWithOrdinary("openai", "gpt-x", 100_000),
    now: fixedClock,
  });
  const decision = await port.getRoutingDecision();
  assert.equal(decision.kind, "plan");
  assert.equal(decision.providerId, "zai");
});

test("额度查询抛错按候选失败处理，回落目录择优", async () => {
  const usageStats = fakeUsageStats({
    snapshots: {},
    snapshotErrors: { bigmodel: new Error("rpc down") },
  });
  const port = createSmartRoutingPort({
    usageStats,
    getCatalog: () => [planEntry("bigmodel", [["glm-4.7", 200_000]])],
    getRegistryView: () => registryViewWithOrdinary("openai", "gpt-x", 100_000),
    now: fixedClock,
  });
  const decision = await port.getRoutingDecision();
  assert.equal(decision.kind, "catalog");
  assert.equal(decision.providerId, "openai");
  assert.match(decision.note, /查询失败/u);
});

test("阈值常量为 5%", () => {
  assert.equal(SMART_ROUTING_LOW_QUOTA_THRESHOLD, 0.05);
});

test("flash 档：简单任务优先消耗剩余最高的轨（免费轨满额时天然优先）", async () => {
  const usageStats = fakeUsageStats({
    snapshots: {
      bigmodel: { state: "authenticated", remainingPercentage: 0.4 },
      start: { state: "authenticated", remainingPercentage: 0.9 },
    },
  });
  const port = createSmartRoutingPort({
    usageStats,
    getCatalog: () => [
      planEntry("bigmodel", [
        ["glm-5.3", 200_000],
        ["glm-5.3-flash", 130_000],
      ]),
      planEntry("start", [["glm-5.3-flash-free", 130_000]]),
    ],
    getRegistryView: () => registryViewWithOrdinary("openai", "gpt-x", 100_000),
    now: fixedClock,
  });
  const decision = await port.getRoutingDecision({ taskPreview: "帮我看看这段代码怎么改" });
  assert.equal(decision.kind, "plan");
  assert.equal(decision.providerId, "start");
  assert.equal(decision.modelId, "glm-5.3-flash-free");
  assert.equal(decision.tier, "flash");
});

test("flash 档 D2：低额度（>0 且 <5%）保持 flash，降级优先于升级", async () => {
  const usageStats = fakeUsageStats({
    snapshots: {
      bigmodel: { state: "authenticated", remainingPercentage: 0.03 },
    },
    cards: { bigmodel: [{ resetType: "FIVE_HOUR", expireAt: fixedClock() + 3_600_000 }] },
  });
  const port = createSmartRoutingPort({
    usageStats,
    getCatalog: () => [
      planEntry("bigmodel", [
        ["glm-5.3", 200_000],
        ["glm-5.3-flash", 130_000],
      ]),
    ],
    getRegistryView: () => registryViewWithOrdinary("openai", "gpt-x", 100_000),
    now: fixedClock,
  });
  const decision = await port.getRoutingDecision({ taskPreview: "帮我看看这段代码怎么改" });
  assert.equal(decision.kind, "plan");
  assert.equal(decision.tier, "flash");
  assert.equal(decision.modelId, "glm-5.3-flash");
  assert.match(decision.note, /降级优先/u);
  assert.equal(usageStats.calls.useCalls.length, 0);
});

test("flash 档 D1：额度归零不选 flash，无卡可用时回落 v1 目录择优", async () => {
  const usageStats = fakeUsageStats({
    snapshots: { bigmodel: { state: "authenticated", remainingPercentage: 0 } },
  });
  const port = createSmartRoutingPort({
    usageStats,
    getCatalog: () => [planEntry("bigmodel", [["glm-5.3-flash", 130_000]])],
    getRegistryView: () => registryViewWithOrdinary("openai", "gpt-x", 100_000),
    now: fixedClock,
  });
  const decision = await port.getRoutingDecision({ taskPreview: "帮我看看这段代码怎么改" });
  assert.equal(decision.kind, "catalog");
  assert.match(decision.note, /回落/u);
  assert.equal(usageStats.calls.useCalls.length, 0);
});

test("s2 深会话：轮次达阈值按复杂任务走 pro 档", async () => {
  const usageStats = fakeUsageStats({
    snapshots: { bigmodel: { state: "authenticated", remainingPercentage: 0.4 } },
  });
  const port = createSmartRoutingPort({
    usageStats,
    getCatalog: () => [planEntry("bigmodel", [["glm-5.3", 200_000]])],
    getRegistryView: () => registryViewWithOrdinary("openai", "gpt-x", 100_000),
    now: fixedClock,
  });
  const decision = await port.getRoutingDecision({
    taskPreview: "继续",
    turnIndex: SMART_TIER_COMPLEX_TURN_INDEX,
  });
  assert.equal(decision.kind, "plan");
  if (decision.kind === "plan") assert.equal(decision.tier, "pro");
});

test("s3 深上下文：既往上下文消息数达阈值按复杂任务走 pro 档", async () => {
  const usageStats = fakeUsageStats({
    snapshots: { bigmodel: { state: "authenticated", remainingPercentage: 0.4 } },
  });
  const port = createSmartRoutingPort({
    usageStats,
    getCatalog: () => [planEntry("bigmodel", [["glm-5.3", 200_000]])],
    getRegistryView: () => registryViewWithOrdinary("openai", "gpt-x", 100_000),
    now: fixedClock,
  });
  const decision = await port.getRoutingDecision({
    taskPreview: "继续",
    contextMessageCount: SMART_TIER_COMPLEX_CONTEXT_MESSAGES,
  });
  assert.equal(decision.kind, "plan");
  if (decision.kind === "plan") assert.equal(decision.tier, "pro");
});

test("pro 档：复杂关键词或长文本走主力模型", async () => {
  const usageStats = fakeUsageStats({
    snapshots: {
      bigmodel: { state: "authenticated", remainingPercentage: 0.4 },
      start: { state: "authenticated", remainingPercentage: 0.9 },
    },
  });
  const port = createSmartRoutingPort({
    usageStats,
    getCatalog: () => [
      planEntry("bigmodel", [
        ["glm-5.3", 200_000],
        ["glm-5.3-flash", 130_000],
      ]),
      planEntry("start", [["glm-5.3-flash-free", 13_000]]),
    ],
    getRegistryView: () => registryViewWithOrdinary("pro-ordinary", "gpt-x", 100_000),
    now: fixedClock,
  });
  const decision = await port.getRoutingDecision({
    taskPreview: "请重构这个模块的架构，并设计新的迁移方案实现性能优化",
  });
  assert.equal(decision.kind, "plan");
  assert.equal(decision.providerId, "bigmodel");
  assert.equal(decision.modelId, "glm-5.3");
  assert.equal(decision.tier, "pro");
});
