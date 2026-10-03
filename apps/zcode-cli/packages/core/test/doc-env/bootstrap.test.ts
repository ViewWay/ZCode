// 文档环境自动就绪编排单测（specs/doc-env-bootstrap.md 验收场景的模块级映射）：
// - 场景 2（已装机器零动作）：fresh ready 缓存且路径仍存在 → 直接 ready，不起子进程；
// - 过期重测 / 缓存 sofficePath 失效重测：重新探测并用注入时钟刷新缓存；
// - 场景 1（全新机器）：三平台 missing + 对应安装指引命令；缺失缓存即使 fresh 也
//   重探测，模拟"用户按指引安装后重试立即就绪"；
// - 损坏缓存回落重测并写回合法缓存；版本读取失败不阻塞 ready。

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { bootstrapDocEnv } from "../../src/doc-env/bootstrap.js";
import {
  type DocEnvState,
  readDocEnvCache,
  resolveDocEnvCachePath,
  writeDocEnvCache,
} from "../../src/doc-env/cache.js";

const NOW_MS = Date.parse("2026-10-03T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const FAKE_SOFFICE = "/opt/libreoffice/bin/soffice";
const GONE_SOFFICE = "/gone/soffice";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(path.join(tmpdir(), "zcode-doc-env-boot-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

/** 可变白名单文件探针：allow() 模拟"用户安装后路径出现"。 */
function mutableFileExists(initial: readonly string[]) {
  const allowList = new Set(initial);
  return {
    probe: async (filePath: string) => allowList.has(filePath),
    allow: (filePath: string) => allowList.add(filePath),
  };
}

const fakeVersionExec = async () => ({ stdout: "LibreOffice 25.8.7.2\n", stderr: "" });

test("场景 2：fresh ready 缓存且路径仍存在 → 直接 ready，无子进程", async () => {
  await withTempHome(async (homeDir) => {
    await writeDocEnvCache(
      { sofficePath: FAKE_SOFFICE, version: "25.8.7.2", fontsOk: false, checkedAt: new Date(NOW_MS - DAY_MS).toISOString() },
      { homeDir },
    );
    let execCalls = 0;
    const result = await bootstrapDocEnv({
      homeDir,
      now: () => NOW_MS,
      platform: "linux",
      fileExists: async (p) => p === FAKE_SOFFICE,
      pathEnv: "/nowhere", // 若误重探测将一无所获，状态翻成 missing，断言即可暴露
      execFileProbe: async () => {
        execCalls += 1;
        return { stdout: "", stderr: "" };
      },
    });
    assert.equal(result.status, "ready");
    assert.equal(result.probed, false);
    assert.equal(result.sofficePath, FAKE_SOFFICE);
    assert.equal(result.version, "25.8.7.2");
    assert.equal(execCalls, 0);
  });
});

test("缓存过期（合成 8 天前）→ 重探测并刷新缓存", async () => {
  await withTempHome(async (homeDir) => {
    const stale: DocEnvState = {
      sofficePath: GONE_SOFFICE,
      version: "24.2.1.2",
      fontsOk: false,
      checkedAt: new Date(NOW_MS - 8 * DAY_MS).toISOString(),
    };
    await writeDocEnvCache(stale, { homeDir });
    const result = await bootstrapDocEnv({
      homeDir,
      now: () => NOW_MS,
      platform: "linux",
      fileExists: async (p) => p === "/usr/bin/soffice",
      pathEnv: "/usr/bin",
      execFileProbe: fakeVersionExec,
    });
    assert.equal(result.status, "ready");
    assert.equal(result.probed, true);
    assert.equal(result.sofficePath, "/usr/bin/soffice");
    assert.equal(result.version, "25.8.7.2");
    const cached = await readDocEnvCache({ homeDir });
    assert.deepEqual(cached, {
      sofficePath: "/usr/bin/soffice",
      version: "25.8.7.2",
      fontsOk: false,
      checkedAt: new Date(NOW_MS).toISOString(),
    });
  });
});

test("缓存 sofficePath 失效（fresh 但路径消失）→ 重测命中新路径", async () => {
  await withTempHome(async (homeDir) => {
    await writeDocEnvCache(
      { sofficePath: GONE_SOFFICE, version: "24.2.1.2", fontsOk: false, checkedAt: new Date(NOW_MS - DAY_MS).toISOString() },
      { homeDir },
    );
    const result = await bootstrapDocEnv({
      homeDir,
      now: () => NOW_MS,
      platform: "darwin",
      fileExists: async (p) => p === "/opt/homebrew/bin/soffice",
      pathEnv: "/opt/homebrew/bin",
      execFileProbe: fakeVersionExec,
    });
    assert.equal(result.status, "ready");
    assert.equal(result.probed, true);
    assert.equal(result.sofficePath, "/opt/homebrew/bin/soffice");
  });
});

test("场景 1：全新机器三平台缺失 → missing + 对应安装指引命令；缺失结果也落缓存", async () => {
  const cases: Array<{ platform: NodeJS.Platform; guide: string }> = [
    { platform: "darwin", guide: "brew install --cask libreoffice" },
    { platform: "win32", guide: "winget install --id TheDocumentFoundation.LibreOffice -e" },
    { platform: "linux", guide: "sudo apt install libreoffice" },
  ];
  await withTempHome(async (homeDir) => {
    for (const { platform, guide } of cases) {
      const result = await bootstrapDocEnv({
        homeDir,
        now: () => NOW_MS,
        platform,
        fileExists: async () => false,
        pathEnv: "/nowhere",
      });
      assert.equal(result.status, "missing", `${platform} 应缺失`);
      assert.equal(result.sofficePath, null);
      assert.equal(result.installGuide, guide);
      const cached = await readDocEnvCache({ homeDir });
      assert.equal(cached?.sofficePath, null, `${platform} 缺失探测结果应落缓存`);
    }
  });
});

test("场景 1 收口：缺失缓存即使 fresh 也重探测，安装后重试立即就绪", async () => {
  await withTempHome(async (homeDir) => {
    const fs = mutableFileExists([]);
    const options = {
      homeDir,
      now: () => NOW_MS,
      platform: "linux" as const,
      fileExists: fs.probe,
      pathEnv: "/opt/libreoffice/bin",
      execFileProbe: fakeVersionExec,
    };
    await writeDocEnvCache(
      { sofficePath: null, version: null, fontsOk: false, checkedAt: new Date(NOW_MS - DAY_MS).toISOString() },
      { homeDir },
    );
    const first = await bootstrapDocEnv(options);
    assert.equal(first.status, "missing");
    assert.equal(first.installGuide, "sudo apt install libreoffice");
    fs.allow(FAKE_SOFFICE); // 用户按指引安装完成
    const second = await bootstrapDocEnv(options);
    assert.equal(second.status, "ready");
    assert.equal(second.probed, true);
    assert.equal(second.sofficePath, FAKE_SOFFICE);
  });
});

test("损坏缓存 → 回落重测并写回合法缓存", async () => {
  await withTempHome(async (homeDir) => {
    const cachePath = resolveDocEnvCachePath(homeDir);
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, "{ not json", "utf8");
    const result = await bootstrapDocEnv({
      homeDir,
      now: () => NOW_MS,
      platform: "linux",
      fileExists: async (p) => p === "/usr/bin/soffice",
      pathEnv: "/usr/bin",
      execFileProbe: fakeVersionExec,
    });
    assert.equal(result.status, "ready");
    const cached = await readDocEnvCache({ homeDir });
    assert.notEqual(cached, null);
    assert.equal(cached?.sofficePath, "/usr/bin/soffice");
  });
});

test("版本读取失败不阻塞 ready（version=null）", async () => {
  await withTempHome(async (homeDir) => {
    const result = await bootstrapDocEnv({
      homeDir,
      now: () => NOW_MS,
      platform: "linux",
      fileExists: async (p) => p === "/usr/bin/soffice",
      pathEnv: "/usr/bin",
      execFileProbe: async () => {
        throw new Error("timed out after 5000ms");
      },
    });
    assert.equal(result.status, "ready");
    assert.equal(result.version, null);
  });
});
