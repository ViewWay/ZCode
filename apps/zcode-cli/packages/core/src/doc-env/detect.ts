// ============================================================
// 文档技能环境探测：LibreOffice（soffice）三平台探测（specs/doc-env-bootstrap.md）
// ============================================================
// 目标：优先复用系统已装的 LibreOffice，不重复安装。探测路径按目标平台区分：
// - macOS：/Applications/LibreOffice.app/Contents/MacOS/soffice，其次 PATH；
// - Windows：Program Files（含 x86 变体）下 LibreOffice\program\soffice.exe；
//   安装器固定落 Program Files，spec 探测表也未含 PATH，故不做 PATH 查找；
// - Linux（及其它非 win32 平台）：PATH。
// 跨平台注意：候选路径属于"目标机器"的文件系统，必须按目标平台的分隔符构造
// （posix/win32 路径模块），不能沿用当前宿主机的 path 默认行为。
// 探针（platform、fileExists、PATH、Program Files）全部可注入，测试注入假路径即可
// 覆盖三平台（spec 验证：探测函数可注入假路径）。
// 版本读取走 child_process.execFile 参数数组形式（禁止 shell 拼接），超时 5s；
// 失败只降级为 version=null，不让环境就绪判定失败。

import { execFile } from "node:child_process";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";

/** 文件存在探针（注入点；默认实现由 bootstrap 层提供）。 */
export type FileExistsProbe = (filePath: string) => Promise<boolean>;

/**
 * 子进程执行探针（注入点；默认 promisify(execFile)）。
 * 外部命令一律参数数组形式调用，禁止 shell 字符串拼接。
 */
export type ExecFileProbe = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

/** 探测输入：platform 与 fileExists 必填（显式注入，本模块不读进程状态）。 */
export interface SofficeProbeInput {
  platform: NodeJS.Platform;
  fileExists: FileExistsProbe;
  /** PATH 环境变量字符串（生产取 process.env.PATH）；win32 不使用。 */
  pathEnv?: string;
  /** Windows Program Files 目录（生产取 process.env["ProgramFiles"]）。 */
  programFilesDir?: string;
  /** Windows x86 Program Files 目录（生产取 process.env["ProgramFiles(x86)"]）。 */
  programFilesX86Dir?: string;
}

/** 探测结果：found 与 sofficePath 同真同假（未命中时 sofficePath 为 null）。 */
export interface SofficeDetection {
  found: boolean;
  sofficePath: string | null;
}

export const SOFFICE_VERSION_TIMEOUT_MS = 5000;

const SOFFICE_BINARY_NAME = "soffice";
const SOFFICE_BINARY_NAME_WINDOWS = "soffice.exe";
const LIBREOFFICE_PROGRAM_SEGMENTS_WINDOWS = ["LibreOffice", "program"];
/** ProgramFiles 环境变量缺失时的兜底值（绝大多数 Windows 安装位置）。 */
const WINDOWS_PROGRAM_FILES_FALLBACK = "C:\\Program Files";
const PATH_DELIMITER_POSIX = ":";
const MACOS_APPLICATION_SOFFICE = "/Applications/LibreOffice.app/Contents/MacOS/soffice";
const SOFFICE_VERSION_PATTERN = /LibreOffice\s+(\S+)/i;

/** 按目标平台生成候选路径（纯函数，顺序即探测优先级）。 */
export function candidateSofficePaths(input: SofficeProbeInput): string[] {
  if (input.platform === "win32") {
    const roots = [input.programFilesDir ?? WINDOWS_PROGRAM_FILES_FALLBACK, input.programFilesX86Dir];
    return roots
      .filter((dir): dir is string => dir !== undefined && dir.trim() !== "")
      .map((dir) =>
        win32.join(dir, ...LIBREOFFICE_PROGRAM_SEGMENTS_WINDOWS, SOFFICE_BINARY_NAME_WINDOWS),
      );
  }
  const fixedCandidates = input.platform === "darwin" ? [MACOS_APPLICATION_SOFFICE] : [];
  return [...fixedCandidates, ...posixPathCandidates(input.pathEnv)];
}

/** PATH 内逐目录查找 soffice；PATH 未注入或为空时无候选。 */
function posixPathCandidates(pathEnv: string | undefined): string[] {
  if (pathEnv === undefined || pathEnv === "") return [];
  return pathEnv
    .split(PATH_DELIMITER_POSIX)
    .filter((dir) => dir !== "")
    .map((dir) => posix.join(dir, SOFFICE_BINARY_NAME));
}

/** 逐候选探测，首个存在者命中；全部落空返回 found:false。 */
export async function detectSoffice(input: SofficeProbeInput): Promise<SofficeDetection> {
  for (const candidate of candidateSofficePaths(input)) {
    if (await input.fileExists(candidate)) {
      return { found: true, sofficePath: candidate };
    }
  }
  return { found: false, sofficePath: null };
}

const promisifiedExecFile = promisify(execFile);

/**
 * 读取 LibreOffice 版本（soffice --version，超时 5s）。
 * 任何失败（超时/非零退出/无可解析输出）返回 null：可执行文件已确认存在，
 * 版本只是记录性降级信息（spec 未定义最低版本数值），不应让就绪判定失败。
 */
export async function readSofficeVersion(
  sofficePath: string,
  execFileProbe: ExecFileProbe = (file, args, options) => promisifiedExecFile(file, args, options),
): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileProbe(sofficePath, ["--version"], {
      timeout: SOFFICE_VERSION_TIMEOUT_MS,
    });
    return parseSofficeVersion(`${stdout}\n${stderr}`);
  } catch {
    return null;
  }
}

/** 从 `LibreOffice 25.8.7 …` 输出中提取版本号 token；无法解析返回 null。 */
function parseSofficeVersion(output: string): string | null {
  const match = SOFFICE_VERSION_PATTERN.exec(output);
  return match === null ? null : (match[1] ?? null);
}
