import { afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Bugfix: jsdom 未实现 DOMMatrix，而 pdfjs-dist 在模块求值期就会读取它（pdf.mjs 顶层），
// 导致任何间接 import pdf 组件的测试在导入阶段即崩（ReferenceError: DOMMatrix is not defined）。
// 单测不做真实光栅化，提供最小占位实现仅满足模块加载与视口计算。
if (typeof globalThis.DOMMatrix === "undefined") {
  // prettier-ignore
  const matrixMembers = {
    a: 1, b: 0, c: 0, d: 1, e: 0, f: 0,
    m11: 1, m12: 0, m13: 0, m14: 0,
    m21: 0, m22: 1, m23: 0, m24: 0,
    m31: 0, m32: 0, m33: 1, m34: 0,
    m41: 0, m42: 0, m43: 0, m44: 1,
  };
  class DOMMatrixStub {
    constructor(init?: number[] | string) {
      if (typeof init === "string") {
        const parts = init.trim().split(/[\s,]+/).map(Number);
        if (parts.length === 6 && parts.every((n) => Number.isFinite(n))) {
          [this.a, this.b, this.c, this.d, this.e, this.f] = parts;
        }
      }
    }
  }
  Object.assign(DOMMatrixStub.prototype, matrixMembers);
  globalThis.DOMMatrix = DOMMatrixStub as unknown as typeof DOMMatrix;
}

process.env.GIT_CONFIG_COUNT = "2";

// Bugfix: Git Bash 会把 /usr/bin（GNU tar 1.35）注入 PATH 最前，子进程 spawn "tar"
// 解析到 GNU tar 后会把归档参数里的 `C:` 当远程主机（"Cannot connect to C"），
// zcode-server-cli 打包/发布与 native-search 归档类测试因此在 Windows 开发机整批失败。
// 真实 Windows 用户 PATH 中 System32 本就靠前、产品环境一直用 bsdtar；这里恢复同样顺序。
if (process.platform === "win32") {
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  if (existsSync(join(system32, "tar.exe"))) {
    const entries = (process.env.PATH ?? "").split(";");
    const rest = entries.filter((entry) => entry.toLowerCase() !== system32.toLowerCase());
    process.env.PATH = [system32, ...rest].join(";");
  }
}
process.env.GIT_CONFIG_KEY_0 = "core.autocrlf";
process.env.GIT_CONFIG_VALUE_0 = "false";
process.env.GIT_CONFIG_KEY_1 = "core.eol";
process.env.GIT_CONFIG_VALUE_1 = "lf";
process.env.ZCODE_TEST_RELEASE_TARGET = process.env.ZCODE_TEST_RELEASE_TARGET ?? "darwin";
process.env.ZCODE_TEST_RELEASE_ARCH = process.env.ZCODE_TEST_RELEASE_ARCH ?? "aarch64";
process.env.ZCODE_TEST_CLIENT_CONFIG_PLATFORM = process.env.ZCODE_TEST_CLIENT_CONFIG_PLATFORM ?? "darwin-aarch64";
// Bugfix: 桌面端会把自定义 dataBaseDir 通过环境变量注入到 host/git 子进程。
// 很多服务层单测只通过覆盖 HOME 来隔离临时目录；若保留该变量，路径解析会继续优先命中真实 dataBaseDir，
// 从而导致“终端本地跑通过，但应用内 git push 触发 pre-push 时大量用例误写到同一目录”。
// 这里在测试入口统一清理，保证单测默认只受各自显式设置的 HOME / setDataBaseDir 控制。
delete process.env.ZCODE_DATA_BASE_DIR;

afterEach(() => {
  delete process.env.ZCODE_DATA_BASE_DIR;
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();

  return {
    ...actual,
    homedir: () => {
      const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
      return envHome && envHome.length > 0 ? envHome : actual.homedir();
    },
  };
});
