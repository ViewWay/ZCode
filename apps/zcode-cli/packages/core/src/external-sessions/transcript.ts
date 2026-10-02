// ============================================================
// Claude Code transcript JSONL 纯解析层（无 fs）
// ============================================================
// 逐行 JSON.parse：type 为 user/assistant 的行提取角色+文本内容；
// content 兼容字符串与 blocks 数组（只取文本类 block，tool_use/tool_result
// 等非文本 block 不取文本）；未知 type 或损坏行跳过并计数，不中断解析。
// summary 行（Claude Code 在文件头部写会话标题）单独提取，不计入跳过。
// 本模块不做任何 IO，时间戳/标题/计数的组装由上层完成。

import type { ExternalSessionMessage } from "@zcode/contracts";

const MESSAGE_LINE_TYPES: ReadonlySet<string> = new Set(["user", "assistant"]);
const SUMMARY_LINE_TYPE = "summary";
const TEXT_BLOCK_TYPE = "text";

export interface ParsedTranscript {
  messages: ExternalSessionMessage[];
  /** 行内 cwd 字段（Claude Code 每行都带）；用于还原 projectPath，不做 slug 反推。 */
  cwd: string | undefined;
  /** summary 行的会话标题；无 summary 行时为 undefined。 */
  summaryTitle: string | undefined;
  /** 首条带文本的 user 消息（title 回退来源）。 */
  firstUserText: string | undefined;
  skippedUnknownLines: number;
  skippedMalformedLines: number;
}

export function parseTranscriptJsonl(content: string): ParsedTranscript {
  const result: ParsedTranscript = {
    messages: [],
    cwd: undefined,
    summaryTitle: undefined,
    firstUserText: undefined,
    skippedUnknownLines: 0,
    skippedMalformedLines: 0,
  };
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      result.skippedMalformedLines += 1;
      continue;
    }
    if (!isRecord(entry)) {
      result.skippedMalformedLines += 1;
      continue;
    }
    if (result.cwd === undefined && typeof entry.cwd === "string") {
      result.cwd = entry.cwd;
    }
    const type = typeof entry.type === "string" ? entry.type : undefined;
    if (type === SUMMARY_LINE_TYPE) {
      if (result.summaryTitle === undefined && typeof entry.summary === "string") {
        result.summaryTitle = entry.summary;
      }
      continue;
    }
    if (type === undefined || !MESSAGE_LINE_TYPES.has(type)) {
      // 未知 type：容错跳过并计数（spec 验收场景 3）。
      result.skippedUnknownLines += 1;
      continue;
    }
    const role = type as ExternalSessionMessage["role"];
    const text = extractTextContent((entry.message as { content?: unknown } | undefined)?.content);
    if (role === "user" && result.firstUserText === undefined && text.trim() !== "") {
      result.firstUserText = text;
    }
    result.messages.push({ role, content: text, ...messageTimestamp(entry) });
  }
  return result;
}

/**
 * content 可能是字符串，或 blocks 数组（text/tool_use/tool_result/...）。
 * 只取文本类 block 的 text 字段，多个 block 用换行拼接；无文本时为空串
 * （tool_result-only 的 user 回合是合法行，保留占位以维持 messageCount 语义）。
 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === TEXT_BLOCK_TYPE && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/** 行级 timestamp（ISO 8601）转 epoch ms；缺失或非法时不输出该字段。 */
function messageTimestamp(entry: Record<string, unknown>): { timestamp?: number } {
  if (typeof entry.timestamp !== "string") return {};
  const epochMs = Date.parse(entry.timestamp);
  return Number.isNaN(epochMs) ? {} : { timestamp: epochMs };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
