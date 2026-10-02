// defaultSession 媒体权限策略单测（specs/voice-pipeline.md「麦克风权限」节）：
// - 纯决策函数：media 仅纯音频放行；含视频或缺 mediaTypes 拒绝；非 media 走默认。
// - 安装函数：default 路径保持默认放行，deny 路径 fail-closed 并留日志。
// 运行：cd <repo-root> && ./node_modules/.bin/tsx --test packages/desktop/test/main/desktopMediaPermissionPolicy.test.ts

import assert from "node:assert/strict";
import test from "node:test";
import {
  installDesktopMediaPermissionPolicy,
  resolveDesktopMediaPermissionDecision,
} from "../../src/main/desktopMediaPermissionPolicy.js";

type Callback = (granted: boolean) => void;
type RequestHandler = (
  webContents: unknown,
  permission: string,
  callback: Callback,
  details: { mediaTypes?: string[] } | undefined,
) => void;

function captureHandler() {
  let installed: RequestHandler | null = null;
  const session = {
    setPermissionRequestHandler(handler: RequestHandler) {
      installed = handler;
    },
  };
  return {
    session,
    invoke(permission: string, details?: { mediaTypes?: string[] }): Promise<boolean> {
      assert.ok(installed, "handler must be installed");
      return new Promise<boolean>((resolve) => {
        installed!(undefined, permission, resolve, details);
      });
    },
  };
}

test("audio-only media requests are allowed", () => {
  assert.equal(resolveDesktopMediaPermissionDecision("media", ["audio"]), "allow");
});

test("media requests containing video or missing mediaTypes are denied", () => {
  // 含视频一律拒绝：应用没有摄像头场景，不能因语音输入把摄像头也放开。
  assert.equal(resolveDesktopMediaPermissionDecision("media", ["audio", "video"]), "deny");
  assert.equal(resolveDesktopMediaPermissionDecision("media", ["video"]), "deny");
  // getUserMedia({audio:true}) 恒携带 ["audio"]；缺失即非常规来源，fail-closed。
  assert.equal(resolveDesktopMediaPermissionDecision("media", undefined), "deny");
  assert.equal(resolveDesktopMediaPermissionDecision("media", []), "deny");
});

test("non-media permissions fall through to the Electron default", () => {
  for (const permission of ["notifications", "clipboard-sanitized-write", "geolocation", "mediaKeySystem"]) {
    assert.equal(
      resolveDesktopMediaPermissionDecision(permission, undefined),
      "default",
      `${permission} must keep default behavior`,
    );
  }
});

test("installed handler preserves default grants and denies camera captures", async () => {
  const logs: unknown[][] = [];
  const { session, invoke } = captureHandler();
  installDesktopMediaPermissionPolicy(session, { info: (...args) => logs.push(args) });

  assert.equal(await invoke("notifications", undefined), true, "existing behavior must not change");
  assert.equal(await invoke("media", { mediaTypes: ["audio"] }), true);
  assert.equal(await invoke("media", { mediaTypes: ["audio", "video"] }), false);
  assert.equal(logs.length, 1, "only denied requests are logged");
});
