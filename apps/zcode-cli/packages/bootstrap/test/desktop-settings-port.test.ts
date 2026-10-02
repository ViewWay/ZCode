// DesktopSettings 协议端口单测（specs/agent-settings.md）：反向转发到宿主的方法与
// 参数、契约尺在转发前拦截非法 value、回包 key 不一致按接线故障拒绝。
// 全部走最小 fake context（只实现 requestClient），不启动协议 server。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test apps/zcode-cli/packages/bootstrap/test/desktop-settings-port.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolClientRequestOptions,
} from "../src/zcode-protocol/server-types.js";
import { createProtocolDesktopSettingsPort } from "../src/zcode-protocol/desktop-settings-port.js";

interface RecordedRequest {
  method: string;
  params: unknown;
  options?: ZCodeProtocolClientRequestOptions;
}

type Responder = (request: RecordedRequest) => unknown;

function fakeContext(respond: Responder): {
  context: ZCodeProtocolAgentServerContext;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const context = {
    requestClient: async (method: string, params: unknown, _resultSchema: unknown, options?: ZCodeProtocolClientRequestOptions) => {
      const request: RecordedRequest = { method, params, ...(options ? { options } : {}) };
      requests.push(request);
      return respond(request);
    },
    logger: { warn() {}, info() {} },
  } as unknown as ZCodeProtocolAgentServerContext;
  return { context, requests };
}

test("get forwards desktopSettings/get with the key and maps the snapshot", async () => {
  const { context, requests } = fakeContext(() => ({
    key: "locale",
    value: "en-US",
    scope: "app",
  }));
  const port = createProtocolDesktopSettingsPort(context);
  const snapshot = await port.get("locale");
  assert.deepEqual(snapshot, { key: "locale", value: "en-US", scope: "app" });
  assert.deepEqual(requests, [
    {
      method: "desktopSettings/get",
      params: { key: "locale" },
      options: { timeoutMs: 10_000 },
    },
  ]);
});

test("set forwards desktopSettings/set after contract-schema validation", async () => {
  const { context, requests } = fakeContext(() => ({
    key: "theme",
    value: "dark",
    scope: "appearance",
    applied: true,
  }));
  const port = createProtocolDesktopSettingsPort(context);
  const snapshot = await port.set("theme", "dark");
  assert.deepEqual(snapshot, { key: "theme", value: "dark", scope: "appearance" });
  assert.deepEqual(requests, [
    {
      method: "desktopSettings/set",
      params: { key: "theme", value: "dark" },
      options: { timeoutMs: 10_000 },
    },
  ]);
});

test("set rejects a value violating the per-key contract schema before any request", async () => {
  const { context, requests } = fakeContext(() => {
    throw new Error("host must not be reached");
  });
  const port = createProtocolDesktopSettingsPort(context);
  // 端口签名只接受合法值联合；这里故意以不安全值直调，验证转发前的运行时契约尺。
  const unsafeValue = (value: unknown) => value as never;
  await assert.rejects(port.set("locale", unsafeValue("fr-FR")));
  await assert.rejects(port.set("theme", unsafeValue("blue")));
  await assert.rejects(port.set("messageStreamShowReasoning", unsafeValue("yes")));
  assert.deepEqual(requests, []);
});

test("a host response for a different key is treated as a wiring fault", async () => {
  const { context } = fakeContext(() => ({
    key: "theme",
    value: "dark",
    scope: "appearance",
  }));
  const port = createProtocolDesktopSettingsPort(context);
  await assert.rejects(port.get("locale"));
  await assert.rejects(port.set("locale", "en-US"));
});
