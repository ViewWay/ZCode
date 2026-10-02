// ============================================================
// 文档技能环境自动就绪编排（specs/doc-env-bootstrap.md）
// ============================================================
// 流程：readCache → fresh 且 sofficePath 仍存在 → 直接 ready（复用缓存版本，
// 不起任何子进程）；否则探测 → 读版本 → 写缓存。
// 两处刻意决策（相对字面 TTL 规则的取舍，均有 spec 依据）：
// 1. 缓存命中只对 ready 状态生效：missing 状态即使 fresh 也每次重探测。探测成本
//    是常数次 stat（无 LibreOffice 时不执行 --version 子进程），而"用户按指引安装后
//    重试立即就绪"（spec 验收场景 1：执行并重试后更新缓存）优先于这点缓存节省。
// 2. 缺失时不静默安装系统级软件（spec：安装动作唯一入口是"用户确认后的指引
//    命令"），只返回平台对应安装指引命令文本，由技能层经权限确认后呈现。
// v1 边界：本模块不接技能（承载位置待定项①未决）；不校验字体（font_list.txt
// 随技能分发，本模块拿不到），fontsOk 保守记 false，待技能接入后补充校验。

import { stat } from "node:fs/promises";

import {
  type ExecFileProbe,
  type FileExistsProbe,
  type SofficeDetection,
  detectSoffice,
  readSofficeVersion,
} from "./detect.js";
import {
  type DocEnvState,
  isDocEnvCacheFresh,
  readDocEnvCache,
  writeDocEnvCache,
} from "./cache.js";

export type DocEnvStatus = "ready" | "missing";

export interface DocEnvBootstrapResult {
  status: DocEnvStatus;
  sofficePath: string | null;
  version: string | null;
  fontsOk: boolean;
  /** 本次调用是否实际执行了探测（false = 命中有效缓存，未起任何子进程）。 */
  probed: boolean;
  /** status === "missing" 时给出平台对应的安装指引命令文本。 */
  installGuide?: string;
}

export interface DocEnvBootstrapOptions {
  /** 缓存主目录（默认 os.homedir()）；测试注入临时目录。 */
  homeDir?: string;
  /** 时钟注入（测试用合成日期）；默认 Date.now。 */
  now?: () => number;
  platform?: NodeJS.Platform;
  fileExists?: FileExistsProbe;
  pathEnv?: string;
  programFilesDir?: string;
  programFilesX86Dir?: string;
  execFileProbe?: ExecFileProbe;
}

const INSTALL_GUIDE_DARWIN = "brew install --cask libreoffice";
const INSTALL_GUIDE_LINUX = "sudo apt install libreoffice";
const INSTALL_GUIDE_WINDOWS = "winget install --id TheDocumentFoundation.LibreOffice -e";
const INSTALL_GUIDE_FALLBACK = "从官网下载安装包：https://www.libreoffice.org/download";

/** 生产默认文件探针：stat 异步存在性探测（ENOENT → false，其它错误冒泡）。 */
const defaultFileExists: FileExistsProbe = async (filePath) => {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNoEntityError(error)) return false;
    throw error;
  }
};

/**
 * 文档技能环境自动就绪入口：读缓存 → 过期/失效重测 → 产出就绪状态。
 * ready 判定为"可执行文件存在"；spec 未定义最低版本数值，版本仅作记录，
 * 引入门槛时在本层比较，不散落到探测层。
 */
export async function bootstrapDocEnv(
  options: DocEnvBootstrapOptions = {},
): Promise<DocEnvBootstrapResult> {
  const platform = options.platform ?? process.platform;
  const fileExists = options.fileExists ?? defaultFileExists;
  const now = options.now ?? Date.now;

  const cached = await readDocEnvCache({ homeDir: options.homeDir });
  if (
    cached !== null &&
    cached.sofficePath !== null &&
    isDocEnvCacheFresh(cached, new Date(now())) &&
    (await fileExists(cached.sofficePath))
  ) {
    return {
      status: "ready",
      sofficePath: cached.sofficePath,
      version: cached.version,
      fontsOk: cached.fontsOk,
      probed: false,
    };
  }

  const detection = await detectSoffice({
    platform,
    fileExists,
    pathEnv: options.pathEnv ?? process.env.PATH,
    programFilesDir: options.programFilesDir ?? process.env["ProgramFiles"],
    programFilesX86Dir: options.programFilesX86Dir ?? process.env["ProgramFiles(x86)"],
  });
  const state = await buildProbedState(detection, now(), options.execFileProbe);
  await writeDocEnvCache(state, { homeDir: options.homeDir });
  return toResult(state, platform);
}

/** 探测结果 → 缓存状态；命中才读版本（避免缺失场景起子进程）。 */
async function buildProbedState(
  detection: SofficeDetection,
  nowMs: number,
  execFileProbe?: ExecFileProbe,
): Promise<DocEnvState> {
  const checkedAt = new Date(nowMs).toISOString();
  if (!detection.found || detection.sofficePath === null) {
    return { sofficePath: null, version: null, fontsOk: false, checkedAt };
  }
  const version = await readSofficeVersion(detection.sofficePath, execFileProbe);
  return { sofficePath: detection.sofficePath, version, fontsOk: false, checkedAt };
}

function toResult(state: DocEnvState, platform: NodeJS.Platform): DocEnvBootstrapResult {
  if (state.sofficePath === null) {
    return { status: "missing", ...state, probed: true, installGuide: resolveInstallGuide(platform) };
  }
  return { status: "ready", ...state, probed: true };
}

/** 平台对应安装指引命令；未识别平台给官网指引，不猜包管理器。 */
function resolveInstallGuide(platform: NodeJS.Platform): string {
  if (platform === "darwin") return INSTALL_GUIDE_DARWIN;
  if (platform === "win32") return INSTALL_GUIDE_WINDOWS;
  if (platform === "linux") return INSTALL_GUIDE_LINUX;
  return INSTALL_GUIDE_FALLBACK;
}

function isNoEntityError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
