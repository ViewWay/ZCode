// 文档环境探测单测（specs/doc-env-bootstrap.md 验证：探测按平台注入假路径）：
// - 候选路径纯函数：macOS 固定路径+PATH、Windows Program Files（x86 变体与默认兜底、
//   忽略 PATH）、Linux 仅 PATH；
// - detectSoffice：三平台命中与全部落空；
// - readSofficeVersion：fake execFile 解析版本、失败降级 null、参数数组与超时契约。

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ExecFileProbe,
  type FileExistsProbe,
  SOFFICE_VERSION_TIMEOUT_MS,
  candidateSofficePaths,
  detectSoffice,
  readSofficeVersion,
} from "../../src/doc-env/detect.js";

const MACOS_APP_SOFFICE = "/Applications/LibreOffice.app/Contents/MacOS/soffice";
const WINDOWS_PF_SOFFICE = "C:\\Program Files\\LibreOffice\\program\\soffice.exe";
const WINDOWS_PF_X86_SOFFICE = "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe";

/** 按白名单放行的假 fileExists：只认 existing 中的路径。 */
function fakeFileExists(existing: readonly string[]): FileExistsProbe {
  const allow = new Set(existing);
  return async (filePath) => allow.has(filePath);
}

test("候选路径：macOS = /Applications 固定路径在前，PATH 候选在后", () => {
  assert.deepEqual(
    candidateSofficePaths({
      platform: "darwin",
      fileExists: fakeFileExists([]),
      pathEnv: "/usr/local/bin:/opt/homebrew/bin",
    }),
    [MACOS_APP_SOFFICE, "/usr/local/bin/soffice", "/opt/homebrew/bin/soffice"],
  );
});

test("候选路径：Windows = Program Files 与 x86 变体（忽略 PATH）；未注入时默认兜底", () => {
  assert.deepEqual(
    candidateSofficePaths({
      platform: "win32",
      fileExists: fakeFileExists([]),
      programFilesDir: "C:\\Program Files",
      programFilesX86Dir: "C:\\Program Files (x86)",
      pathEnv: "D:\\tools", // spec：Windows 不做 PATH 查找
    }),
    [WINDOWS_PF_SOFFICE, WINDOWS_PF_X86_SOFFICE],
  );
  assert.deepEqual(
    candidateSofficePaths({ platform: "win32", fileExists: fakeFileExists([]) }),
    [WINDOWS_PF_SOFFICE],
  );
});

test("候选路径：Linux 仅 PATH；PATH 缺省或为空时无候选", () => {
  assert.deepEqual(
    candidateSofficePaths({
      platform: "linux",
      fileExists: fakeFileExists([]),
      pathEnv: "/usr/bin:/snap/bin",
    }),
    ["/usr/bin/soffice", "/snap/bin/soffice"],
  );
  assert.deepEqual(candidateSofficePaths({ platform: "linux", fileExists: fakeFileExists([]) }), []);
});

test("detectSoffice：macOS 命中 /Applications 安装路径", async () => {
  const detection = await detectSoffice({
    platform: "darwin",
    fileExists: fakeFileExists([MACOS_APP_SOFFICE]),
  });
  assert.deepEqual(detection, { found: true, sofficePath: MACOS_APP_SOFFICE });
});

test("detectSoffice：macOS 回退 PATH 命中 Homebrew 路径", async () => {
  const detection = await detectSoffice({
    platform: "darwin",
    fileExists: fakeFileExists(["/opt/homebrew/bin/soffice"]),
    pathEnv: "/usr/local/bin:/opt/homebrew/bin",
  });
  assert.deepEqual(detection, { found: true, sofficePath: "/opt/homebrew/bin/soffice" });
});

test("detectSoffice：Windows 命中 Program Files 假路径", async () => {
  const detection = await detectSoffice({
    platform: "win32",
    fileExists: fakeFileExists([WINDOWS_PF_SOFFICE]),
  });
  assert.deepEqual(detection, { found: true, sofficePath: WINDOWS_PF_SOFFICE });
});

test("detectSoffice：Linux 命中 PATH 假路径；全部落空返回 null", async () => {
  const found = await detectSoffice({
    platform: "linux",
    fileExists: fakeFileExists(["/usr/bin/soffice"]),
    pathEnv: "/usr/bin",
  });
  assert.deepEqual(found, { found: true, sofficePath: "/usr/bin/soffice" });
  const missing = await detectSoffice({
    platform: "linux",
    fileExists: fakeFileExists([]),
    pathEnv: "/usr/bin:/usr/local/bin",
  });
  assert.deepEqual(missing, { found: false, sofficePath: null });
});

test("readSofficeVersion：解析 stdout 版本号；参数数组 + 5s 超时契约", async () => {
  const calls: Array<{ file: string; args: string[]; options: { timeout: number } }> = [];
  const probe: ExecFileProbe = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: "LibreOffice 25.8.7.2 123456 (Debug:ABC)\n", stderr: "" };
  };
  assert.equal(await readSofficeVersion("/fake/soffice", probe), "25.8.7.2");
  assert.deepEqual(calls, [
    { file: "/fake/soffice", args: ["--version"], options: { timeout: SOFFICE_VERSION_TIMEOUT_MS } },
  ]);
});

test("readSofficeVersion：stderr 输出也能解析；失败/无版本输出降级 null", async () => {
  const stderrOnly: ExecFileProbe = async () => ({ stdout: "", stderr: " LibreOffice 24.8.4.2" });
  assert.equal(await readSofficeVersion("/fake/soffice", stderrOnly), "24.8.4.2");
  const failing: ExecFileProbe = async () => {
    throw new Error("timed out after 5000ms");
  };
  assert.equal(await readSofficeVersion("/fake/soffice", failing), null);
  const noVersion: ExecFileProbe = async () => ({ stdout: "usage: soffice [options]\n", stderr: "" });
  assert.equal(await readSofficeVersion("/fake/soffice", noVersion), null);
});
