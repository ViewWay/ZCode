// ModelPropertiesConfig 能力声明叠加单测：普通对象按 ConfigOverlay 约定整体替换
// （不按字段深合并），toJSON/validateComplete 不丢 capabilities。这保证 builtin
// 与 personal 规则合成后能力声明与 contextWindow 等叶子走同一套语义。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test packages/provider/test/model-properties-capabilities.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import { ModelPropertiesConfig } from "../src/config/model-config.js";

const BASE = {
  requiresMfjsToolSchema: false,
  contextWindow: 128_000,
  inputFormat: {
    supportsText: true,
    supportsImage: true,
    supportsVideo: false,
    supportsAudio: false,
    supportsPdf: false,
  },
  outputFormat: { supportsText: true },
  supportsToolCall: true,
  supportsJsonSchemaOutput: true,
  supportsNativeWebSearch: false,
  supportsMidConversationSystem: true,
};

test("capabilities 随 overlay 整体替换（上层声明覆盖下层）", () => {
  const base = new ModelPropertiesConfig({
    ...BASE,
    capabilities: { image: true, transcription: false },
  });
  const overlay = base.overlay(new ModelPropertiesConfig({ capabilities: { speech: true } }));
  assert.deepEqual(overlay.capabilities, { speech: true });
});

test("上层未声明 capabilities 时继承下层", () => {
  const base = new ModelPropertiesConfig({ ...BASE, capabilities: { image: true } });
  const overlay = base.overlay(new ModelPropertiesConfig({ contextWindow: 64_000 }));
  assert.deepEqual(overlay.capabilities, { image: true });
  assert.equal(overlay.contextWindow, 64_000);
});

test("toJSON 保留 capabilities，complete 校验通过（缺 capabilities 同样通过）", () => {
  const withCapabilities = new ModelPropertiesConfig({
    ...BASE,
    capabilities: { image: true },
  });
  assert.deepEqual(withCapabilities.toJSON().capabilities, { image: true });
  assert.equal(withCapabilities.validateComplete().length, 0);

  const withoutCapabilities = new ModelPropertiesConfig(BASE);
  assert.equal(withoutCapabilities.validateComplete().length, 0);
});
