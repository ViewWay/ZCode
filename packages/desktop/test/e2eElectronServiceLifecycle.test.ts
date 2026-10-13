import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  initializeE2EElectronServiceBridge,
  registerE2EElectronServiceBridgeReload,
  reloadE2EElectronServiceBridge,
} from "./e2e/helpers/e2e-electron-service-lifecycle.js";

describe("desktop e2e Electron service lifecycle", () => {
  it("does not reconnect when the first bridge probe succeeds", async () => {
    const events: string[] = [];

    await initializeE2EElectronServiceBridge({
      initialize: async () => {
        events.push("initialize");
      },
      probe: async () => {
        events.push("probe");
      },
      reset: () => {
        events.push("reset");
      },
    });

    expect(events).toEqual(["initialize", "probe"]);
  });

  it("rebuilds the bridge once when the first probe fails", async () => {
    const events: string[] = [];
    const probe = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("ContextId missing"))
      .mockResolvedValueOnce();

    await initializeE2EElectronServiceBridge({
      initialize: async () => {
        events.push("initialize");
      },
      probe: async () => {
        events.push("probe");
        await probe();
      },
      reset: () => {
        events.push("reset");
      },
    });

    expect(events).toEqual(["initialize", "probe", "reset", "initialize", "probe"]);
  });

  it("surfaces the second bridge failure instead of looping", async () => {
    const initialize = vi.fn<() => Promise<void>>().mockResolvedValue();
    const reset = vi.fn<() => void>();

    await expect(
      initializeE2EElectronServiceBridge({
        initialize,
        probe: async () => {
          throw new Error("bridge unavailable");
        },
        reset,
      }),
    ).rejects.toThrow("两次初始化后仍不可用");
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("wraps the existing service package with the local reload-aware service module", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { devDependencies?: Record<string, string> };
    const serviceSource = readFileSync(
      new URL("./e2e/helpers/e2e-electron-service.ts", import.meta.url),
      "utf8",
    );
    const wdioSource = readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");

    expect(packageJson.devDependencies?.["wdio-electron-service"]).toBe("^9.2.1");
    expect(packageJson.devDependencies?.["@wdio/electron-types"]).toBe("^9.2.1");
    expect(serviceSource).toContain(
      "export const launcher: typeof ElectronLauncherService = ElectronLauncherService",
    );
    expect(serviceSource).toContain("async onReload()");
    expect(serviceSource).toContain("registerE2EElectronServiceBridgeReload(");
    expect(wdioSource).toContain("E2E_ELECTRON_SERVICE_MODULE_PATH");
  });

  it("cancels the ContextId timeout after the default execution context is found", () => {
    // 修复原因：pnpm 10 起 patchedDependencies 的登记位置从 package.json 的 pnpm 字段
    // 迁移到 pnpm-workspace.yaml（本仓约定：上游 v3.15.1 新增补丁原登记在 package.json，
    // 合并时按迁移约定并入 workspace 配置）。断言意图不变——校验补丁已在配置层登记。
    const workspaceYaml = readFileSync(
      new URL("../../../pnpm-workspace.yaml", import.meta.url),
      "utf8",
    );
    const patchedDependenciesBlock = workspaceYaml.slice(
      workspaceYaml.indexOf("patchedDependencies:"),
    );
    const electronServiceSource = readFileSync(
      new URL(
        "../../../node_modules/wdio-electron-service/dist/esm/index.js",
        import.meta.url,
      ),
      "utf8",
    );
    const contextIdHandler = electronServiceSource.slice(
      electronServiceSource.indexOf(
        "_ElectronCdpBridge_getContextIdHandler = function",
      ),
      electronServiceSource.indexOf("function getInitializeScript()"),
    );

    // Bug 根因：上游 9.2.1 的 ContextId Promise 成功 resolve 后没有取消 timeout，
    // 定时器仍会在健康 case 运行期间打印误导性的 Timeout exceeded error。
    expect(patchedDependenciesBlock).toContain(
      "'wdio-electron-service@9.2.1': patches/wdio-electron-service@9.2.1.patch",
    );
    expect(contextIdHandler).toContain("clearTimeout(timeout)");
    expect(contextIdHandler).toContain(
      "this.off('Runtime.executionContextCreated', onExecutionContextCreated)",
    );
  });

  it("routes a browser reload through the bridge callback registered by the service", async () => {
    const browser = {} as WebdriverIO.Browser;
    const reload = vi.fn(async () => undefined);

    registerE2EElectronServiceBridgeReload(browser, reload);
    await reloadE2EElectronServiceBridge(browser);

    expect(reload).toHaveBeenCalledOnce();
  });
});
