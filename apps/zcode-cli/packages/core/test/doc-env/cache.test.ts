// 文档环境缓存单测（specs/doc-env-bootstrap.md 验证：缓存读写与过期重测）：
// - 读写往返（自动创建 ~/.zcode 目录）；
// - 新鲜度：合成日期覆盖 6 天 / 恰好 7 天 / 7 天+1ms / 8 天与非法 checkedAt；
// - 损坏缓存（非法 JSON / 字段形态不符）与文件缺失一律返回 null（回落重测）。
// 原子写入（tmp+rename）不单独测试，行为由写入路径直接保证。

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  type DocEnvState,
  DOC_ENV_CACHE_TTL_MS,
  isDocEnvCacheFresh,
  readDocEnvCache,
  resolveDocEnvCachePath,
  writeDocEnvCache,
} from "../../src/doc-env/cache.js";

const NOW_MS = Date.parse("2026-10-03T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const READY_STATE: DocEnvState = {
  sofficePath: "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  version: "25.8.7.2",
  fontsOk: false,
  checkedAt: "2026-10-02T12:00:00.000Z",
};

function stateAt(checkedAt: string): DocEnvState {
  return { ...READY_STATE, checkedAt };
}

test("读写往返：write 自动建 .zcode 目录，read 还原全量字段", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "zcode-doc-env-"));
  try {
    await writeDocEnvCache(READY_STATE, { homeDir });
    assert.deepEqual(await readDocEnvCache({ homeDir }), READY_STATE);
    assert.equal(resolveDocEnvCachePath(homeDir), path.join(homeDir, ".zcode", "doc-env.json"));
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("文件缺失 → null（首次运行未探测）", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "zcode-doc-env-"));
  try {
    assert.equal(await readDocEnvCache({ homeDir }), null);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("损坏缓存回落重测：非法 JSON / 字段形态不符 → null", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "zcode-doc-env-"));
  try {
    const cachePath = resolveDocEnvCachePath(homeDir);
    await mkdir(path.dirname(cachePath), { recursive: true });
    const invalidPayloads = [
      "{ not json",
      JSON.stringify({ sofficePath: 42, version: null, fontsOk: false, checkedAt: READY_STATE.checkedAt }),
      JSON.stringify({ sofficePath: "/x", version: null, fontsOk: "yes", checkedAt: READY_STATE.checkedAt }),
      JSON.stringify({ sofficePath: "/x", version: null, fontsOk: true, checkedAt: "not-a-date" }),
    ];
    for (const payload of invalidPayloads) {
      await writeFile(cachePath, payload, "utf8");
      assert.equal(await readDocEnvCache({ homeDir }), null, `payload 应判定为损坏: ${payload}`);
    }
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("新鲜度：checkedAt 合成日期驱动 7 天 TTL", () => {
  const now = new Date(NOW_MS);
  const daysAgo = (days: number) => new Date(NOW_MS - days * DAY_MS).toISOString();
  assert.equal(isDocEnvCacheFresh(stateAt(daysAgo(6)), now), true);
  // 恰好 7 天不算"超过"，仍新鲜；超过 1ms 即过期
  assert.equal(isDocEnvCacheFresh(stateAt(daysAgo(7)), now), true);
  assert.equal(
    isDocEnvCacheFresh(stateAt(new Date(NOW_MS - DOC_ENV_CACHE_TTL_MS - 1).toISOString()), now),
    false,
  );
  assert.equal(isDocEnvCacheFresh(stateAt(daysAgo(8)), now), false);
  assert.equal(isDocEnvCacheFresh(stateAt("not-a-date"), now), false);
});
