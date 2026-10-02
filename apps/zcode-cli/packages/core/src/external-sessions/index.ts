// ============================================================
// 外部会话只读互操作入口（specs/external-sessions.md）
// ============================================================
// 数据源：~/.claude/projects/<项目目录slug>/*.jsonl（Claude Code transcript）。
// 无缓存无持久化：每次调用实时读盘（v1 明确不建索引）；全部异步 fs API。
// 目录枚举 + 逐行解析为主，不依赖目录 slug 反推项目路径（projectPath 取自行内
// cwd 字段）。目录不存在返回空列表不报错（spec 验收场景 2）。
// 严格只读：本模块不包含任何写路径。

import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EXTERNAL_SESSION_TITLE_MAX_CHARS,
  type ExternalSessionSummary,
  type ReadExternalSessionOutput,
} from "@zcode/contracts";
import { assertPathWithinRoot, resolveExternalSessionsRoot } from "./paths.js";
import { parseTranscriptJsonl } from "./transcript.js";

const JSONL_EXTENSION = ".jsonl";

export interface ExternalSessionFsOptions {
  /** 覆盖主目录（默认 os.homedir()）；测试注入临时目录。 */
  homeDir?: string;
}

/** read_external_session 找不到对应 transcript 时的稳定错误形态。 */
export class ExternalSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(
      `External session not found: ${sessionId}. Call list_external_sessions for available ids.`,
    );
    this.name = "ExternalSessionNotFoundError";
  }
}

/**
 * 列出外部会话元数据（spec：list 只出元数据，不出消息内容）。
 * 结果按 lastUpdatedAt 降序（最新在前），服务「继续上次的工作」场景。
 */
export async function listExternalSessions(
  input: { projectPath?: string } = {},
  options: ExternalSessionFsOptions = {},
): Promise<ExternalSessionSummary[]> {
  const root = resolveRoot(options);
  const sessions: ExternalSessionSummary[] = [];
  for (const dirName of await listProjectDirectories(root)) {
    const dirPath = path.join(root, dirName);
    for (const fileName of await listTranscriptFiles(dirPath)) {
      const filePath = path.join(dirPath, fileName);
      const summary = await summarizeTranscriptFile(root, filePath, fileName);
      if (summary === undefined) continue;
      if (
        input.projectPath !== undefined &&
        summary.projectPath !== path.resolve(input.projectPath)
      ) {
        continue;
      }
      sessions.push(summary);
    }
  }
  sessions.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
  return sessions;
}

/** 读取单个外部会话的消息内容；坏行跳过并聚合进 warnings（不中断读取）。 */
export async function readExternalSession(
  input: { sessionId: string },
  options: ExternalSessionFsOptions = {},
): Promise<ReadExternalSessionOutput> {
  const sessionId = validateSessionId(input.sessionId);
  const root = resolveRoot(options);
  // sessionId 只是文件名段；跨项目目录全局查找（uuid 文件名，实际不冲突）。
  for (const dirName of await listProjectDirectories(root)) {
    const filePath = path.join(root, dirName, sessionId + JSONL_EXTENSION);
    if (!(await pathExists(filePath))) continue;
    await assertPathWithinRoot(root, filePath);
    const parsed = parseTranscriptJsonl(await readFile(filePath, "utf8"));
    return {
      sessionId,
      ...buildOptionalTitle(parsed),
      projectPath: parsed.cwd ?? "",
      messages: parsed.messages,
      messageCount: parsed.messages.length,
      ...buildSkippedLineWarnings(parsed),
    };
  }
  throw new ExternalSessionNotFoundError(sessionId);
}

function resolveRoot(options: ExternalSessionFsOptions): string {
  return resolveExternalSessionsRoot(options.homeDir ?? os.homedir());
}

/**
 * 枚举 projects 下的项目目录。根目录不存在返回 []（spec 验收场景 2）；
 * 其它错误（如权限）向上冒泡，不静默吞掉。
 */
async function listProjectDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (isNoEntityError(error)) return [];
    throw error;
  }
}

/**
 * 枚举单项目目录下的 transcript 文件（.jsonl 常规文件）。
 * withFileTypes 基于 lstat：符号链接条目天然被跳过，配合 assertPathWithinRoot
 * 的 realpath 防线构成双重边界。
 */
async function listTranscriptFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(JSONL_EXTENSION))
      .map((entry) => entry.name);
  } catch (error) {
    if (isNoEntityError(error)) return [];
    throw error;
  }
}

/** 单个 transcript 文件的元数据化；不可读（权限/竞态删除）时跳过该文件。 */
async function summarizeTranscriptFile(
  root: string,
  filePath: string,
  fileName: string,
): Promise<ExternalSessionSummary | undefined> {
  await assertPathWithinRoot(root, filePath);
  let content: string;
  let mtimeMs: number;
  try {
    content = await readFile(filePath, "utf8");
    mtimeMs = (await stat(filePath)).mtimeMs;
  } catch (error) {
    // 列表是枚举面：单文件不可读只影响自身（竞态删除/权限），跳过而不中断整表。
    if (isNoEntityError(error) || isPermissionError(error)) return undefined;
    throw error;
  }
  const parsed = parseTranscriptJsonl(content);
  return {
    sessionId: fileName.slice(0, -JSONL_EXTENSION.length),
    ...buildOptionalTitle(parsed),
    projectPath: parsed.cwd ?? "",
    ...(firstTimestamp(parsed) === undefined ? {} : { startedAt: firstTimestamp(parsed) }),
    lastUpdatedAt: lastTimestamp(parsed) ?? mtimeMs,
    messageCount: parsed.messages.length,
  };
}

/** title：summary 行优先，否则首条用户消息截断（空白折叠为单行）。 */
function buildOptionalTitle(parsed: ReturnType<typeof parseTranscriptJsonl>): { title?: string } {
  const raw = parsed.summaryTitle ?? parsed.firstUserText;
  if (raw === undefined) return {};
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized === "") return {};
  return { title: truncateTitle(normalized) };
}

function truncateTitle(title: string): string {
  return title.length <= EXTERNAL_SESSION_TITLE_MAX_CHARS
    ? title
    : title.slice(0, EXTERNAL_SESSION_TITLE_MAX_CHARS - 1) + "…";
}

function firstTimestamp(parsed: ReturnType<typeof parseTranscriptJsonl>): number | undefined {
  for (const message of parsed.messages) {
    if (message.timestamp !== undefined) return message.timestamp;
  }
  return undefined;
}

function lastTimestamp(parsed: ReturnType<typeof parseTranscriptJsonl>): number | undefined {
  for (let i = parsed.messages.length - 1; i >= 0; i -= 1) {
    const timestamp = parsed.messages[i]?.timestamp;
    if (timestamp !== undefined) return timestamp;
  }
  return undefined;
}

/** 跳过行聚合为 warnings（未知 type / 损坏行计数）；无跳过时省略字段。 */
function buildSkippedLineWarnings(parsed: ReturnType<typeof parseTranscriptJsonl>): {
  warnings?: string[];
} {
  const total = parsed.skippedUnknownLines + parsed.skippedMalformedLines;
  if (total === 0) return {};
  const parts: string[] = [];
  if (parsed.skippedUnknownLines > 0) {
    parts.push(`${parsed.skippedUnknownLines} unknown type`);
  }
  if (parsed.skippedMalformedLines > 0) {
    parts.push(`${parsed.skippedMalformedLines} malformed`);
  }
  return { warnings: [`Skipped ${total} lines (${parts.join(", ")})`] };
}

/**
 * sessionId 必须是单段文件名（Claude Code 用 uuid），拒绝任何携带路径分隔符
 * 或 . / .. 的输入，防止路径穿越。
 */
function validateSessionId(sessionId: string): string {
  if (
    sessionId === "" ||
    sessionId === "." ||
    sessionId === ".." ||
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes("\0")
  ) {
    throw new Error(`Invalid external session id: ${JSON.stringify(sessionId)}`);
  }
  return sessionId;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNoEntityError(error)) return false;
    throw error;
  }
}

function isNoEntityError(error: unknown): boolean {
  return isErrorWithCode(error) && error.code === "ENOENT";
}

function isPermissionError(error: unknown): boolean {
  return isErrorWithCode(error) && (error.code === "EACCES" || error.code === "EPERM");
}

function isErrorWithCode(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}
