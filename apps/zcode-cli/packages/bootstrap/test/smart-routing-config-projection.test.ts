// B3 UI 消费面（specs/smart-routing-v3.md）config 投影裁决单测：
// 设值/清除/hydration 不触碰/同值不变化。运行：
// ./node_modules/.bin/tsx --test apps/zcode-cli/packages/bootstrap/test/smart-routing-config-projection.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelSelectedPayload } from "@zcode/contracts";

import { resolveSmartRoutingConfigValue } from "../src/zcode-protocol-v4/smart-routing-config.js";

const FLASH = { tier: "flash", note: "n" } as const;
const PRO = { tier: "pro", note: "n" } as const;
const FLASH_A = { tier: "flash", note: "a" } as const;

test("hydration 合成事件不触碰 Smart 决策面", () => {
  const result = resolveSmartRoutingConfigValue({
    previous: FLASH_A,
    payloadSmartRouting: PRO,
    isHydration: true,
  });
  assert.deepEqual(result, { next: FLASH_A, changed: false });
});

test("事件带 smartRouting → 设值；prev 空则记变化", () => {
  assert.deepEqual(resolveSmartRoutingConfigValue({ previous: null, payloadSmartRouting: FLASH }), {
    next: { tier: "flash", note: "n" },
    changed: true,
  });
});

test("同值重复事件不产生变化", () => {
  assert.deepEqual(
    resolveSmartRoutingConfigValue({ previous: FLASH, payloadSmartRouting: FLASH }),
    { next: FLASH, changed: false },
  );
});

test("换档（tier 或 note 变）记变化", () => {
  assert.equal(
    resolveSmartRoutingConfigValue({ previous: FLASH_A, payloadSmartRouting: PRO }).changed,
    true,
  );
  assert.equal(
    resolveSmartRoutingConfigValue({ previous: FLASH, payloadSmartRouting: { tier: "flash", note: "b" } })
      .changed,
    true,
  );
});

test("事件不带 smartRouting → 清除；prev 空则无变化", () => {
  assert.deepEqual(resolveSmartRoutingConfigValue({ previous: FLASH, payloadSmartRouting: undefined }), {
    next: null,
    changed: true,
  });
  assert.deepEqual(
    resolveSmartRoutingConfigValue({ previous: null, payloadSmartRouting: undefined }),
    { next: null, changed: false },
  );
});
