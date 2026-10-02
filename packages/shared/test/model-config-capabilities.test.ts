// model-config 能力声明 schema 单测（specs/image-tools.md、specs/voice-pipeline.md）：
// sparse/complete 均可选（既有数据不因缺 capabilities 判为不完整）、strict 拒绝未知
// 叶子、布尔类型校验。运行：cd <repo-root> && ./node_modules/.bin/tsx --test packages/shared/test/model-config-capabilities.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  completeModelPropertiesDataSchema,
  modelPropertiesDataSchema,
} from "../src/model-config.js";

const BASE_PROPERTIES = {
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

test("complete schema 允许缺省 capabilities（既有数据升级兼容）", () => {
  const parsed = completeModelPropertiesDataSchema.parse(BASE_PROPERTIES);
  assert.equal(parsed.capabilities, undefined);
});

test("complete schema 接受部分能力声明", () => {
  const parsed = completeModelPropertiesDataSchema.parse({
    ...BASE_PROPERTIES,
    capabilities: { image: true },
  });
  assert.deepEqual(parsed.capabilities, { image: true });
});

test("sparse schema 允许只写 capabilities", () => {
  const parsed = modelPropertiesDataSchema.parse({ capabilities: { transcription: true } });
  assert.deepEqual(parsed.capabilities, { transcription: true });
});

test("能力叶子必须是布尔且拒绝未知键（strict）", () => {
  assert.throws(() =>
    modelPropertiesDataSchema.parse({ capabilities: { image: "yes" } }),
  );
  assert.throws(() =>
    modelPropertiesDataSchema.parse({ capabilities: { video: true } }),
  );
});
