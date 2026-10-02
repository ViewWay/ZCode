// 规则式候选提取（specs/auto-distill.md 的 v1 规则实现）：
// - 重复出现的命令序列：跨会话统计命令行出现次数与覆盖会话数，达到阈值即产出候选。
//   命令行只认三类低噪信号——围栏代码块内、`$ ` 提示符行、行内反引号代码；
//   且首个 token 必须在已知命令白名单内，避免把输出文本或普通散文误判成命令。
// - 被用户采纳的修复模式：连续 assistant 回复组中存在"修复类"叙述（按去代码后的
//   散文判定，防止 commit message 里的 fix 误命中），且在下一组 assistant 回复前
//   出现用户确认语（短句、以确认词开头）。
// 提取是纯函数：会话文本片段由宿主注入（"近期会话 → 片段"的映射在接线层完成），
// 不做任何 IO，保证离线可验证；模型提取实现（spec 中的可选开关）由接线层替换注入。
// 运行测试：cd <repo-root> && ./node_modules/.bin/tsx --test apps/zcode-cli/packages/core/test/auto-distill/extract.test.ts

import { createHash } from "node:crypto";

import type {
  DistillCandidate,
  DistillSessionFragment,
  DistillSessionInput,
} from "@zcode/shared";

/** 命令行首个 token 白名单：只统计开发工作流里高频、可复用的命令。 */
const KNOWN_COMMAND_TOKENS = new Set([
  "pnpm",
  "npm",
  "yarn",
  "bun",
  "node",
  "npx",
  "tsx",
  "tsc",
  "git",
  "cargo",
  "rustc",
  "go",
  "make",
  "cmake",
  "python",
  "python3",
  "pip",
  "uv",
  "pytest",
  "docker",
  "podman",
  "kubectl",
  "helm",
  "terraform",
  "curl",
  "wget",
  "ssh",
  "jq",
  "rg",
  "grep",
  "sed",
  "awk",
]);

const MIN_COMMAND_OCCURRENCES = 2;
const MIN_COMMAND_LENGTH = 4;
const COMMAND_MAX_LENGTH = 120;
const SUMMARY_MAX_LENGTH = 120;
/** 修复类叙述的最短散文长度：过滤掉孤立关键词或纯命令输出。 */
const MIN_FIX_PROSE_LENGTH = 12;
/** 用户确认语的最大长度：确认必须是短句，长反馈不算采纳。 */
const USER_CONFIRMATION_MAX_LENGTH = 24;

/** assistant 散文"像一次修复"的信号词。中文无词边界，英文用 \b 防止误命中。 */
const FIX_LIKE_PATTERN =
  /修复|根因|已解决|解决了|问题在于|bug|root cause|\bfix(ed|es)?\b|\bresolved?\b/iu;
/** 根因类表述的加分信号：说明结论解释了"为什么"，而不只是"改了什么"。 */
const ROOT_CAUSE_PATTERN = /根因|root cause|原因[:：]/iu;
/** 用户确认语：整句必须短且以确认词开头，尾部允许标点或短语补充。 */
const USER_CONFIRMATION_PATTERN =
  /^(好的?|对|是的?|没错|正确|就是这样|完美|可以|嗯+|ok|okay|great|nice|perfect|thanks?|谢谢|感谢|太棒了|棒|确认|搞定|没问题|工作正常)[^\n]{0,16}$/iu;

// 置信度公式（v1 规则式，统一 clamp 到 [0, CONFIDENCE_MAX]）：
// 规则置信度永远到不了 1，保留"需人工审阅"语义（spec 非目标：禁止静默自动写入）。
const REPEATED_COMMAND_BASE_CONFIDENCE = 0.55;
const REPEATED_COMMAND_PER_EXTRA_OCCURRENCE = 0.05;
const REPEATED_COMMAND_CROSS_SESSION_BONUS = 0.15;
const ADOPTED_FIX_BASE_CONFIDENCE = 0.6;
const ADOPTED_FIX_ROOT_CAUSE_BONUS = 0.1;
const ADOPTED_FIX_CONSECUTIVE_ASSISTANT_BONUS = 0.05;
const CONFIDENCE_MAX = 0.9;

export interface ExtractDistillCandidatesOptions {
  /** 注入时钟；测试用它固定 createdAt，生产默认取当前时间。 */
  now?: () => Date;
}

/**
 * 从近期会话片段提取沉淀候选。同 id 取置信度更高者（同输入完全确定），
 * 输出按置信度降序、再按 id 排序，与设置页"按置信度排序"的审阅要求一致。
 */
export function extractDistillCandidates(
  sessions: readonly DistillSessionInput[],
  options: ExtractDistillCandidatesOptions = {},
): DistillCandidate[] {
  const createdAt = (options.now ?? defaultNow)().toISOString();
  const collected = new Map<string, DistillCandidate>();
  const upsert = (candidate: DistillCandidate): void => {
    const existing = collected.get(candidate.id);
    if (!existing || candidate.confidence > existing.confidence) {
      collected.set(candidate.id, candidate);
    }
  };

  collectRepeatedCommandCandidates(sessions, createdAt, upsert);
  collectAdoptedFixCandidates(sessions, createdAt, upsert);

  return [...collected.values()].sort(
    (left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id, "en"),
  );
}

// ── 重复出现的命令序列 ─────────────────────────────────────────

interface CommandOccurrence {
  count: number;
  sessionIds: Set<string>;
  /** 首次出现所在会话，作为候选的来源会话。 */
  sourceSessionId: string;
}

function collectRepeatedCommandCandidates(
  sessions: readonly DistillSessionInput[],
  createdAt: string,
  emit: (candidate: DistillCandidate) => void,
): void {
  const occurrences = new Map<string, CommandOccurrence>();
  for (const session of sessions) {
    const seenInSession = new Set<string>();
    for (const fragment of session.fragments) {
      for (const command of extractCommandLines(fragment.text)) {
        let occurrence = occurrences.get(command);
        if (!occurrence) {
          occurrence = {
            count: 0,
            sessionIds: new Set<string>(),
            sourceSessionId: session.sessionId,
          };
          occurrences.set(command, occurrence);
        }
        occurrence.count += 1;
        if (!seenInSession.has(command)) {
          seenInSession.add(command);
          occurrence.sessionIds.add(session.sessionId);
        }
      }
    }
  }

  for (const [command, occurrence] of occurrences) {
    if (occurrence.count < MIN_COMMAND_OCCURRENCES) continue;
    const crossSession = occurrence.sessionIds.size >= 2;
    // id 不含来源会话：提取窗口滑动（不同批次近期会话）时同一命令仍是同一候选，
    // store.add 按 id upsert，避免窗口移动产生重复条目。
    const id = buildCandidateId("repeated-command", command);
    emit({
      id,
      kind: "repeated-command",
      summary: buildRepeatedCommandSummary(command, occurrence),
      sourceSessionId: occurrence.sourceSessionId,
      confidence: clampConfidence(
        REPEATED_COMMAND_BASE_CONFIDENCE +
          (occurrence.count - MIN_COMMAND_OCCURRENCES) * REPEATED_COMMAND_PER_EXTRA_OCCURRENCE +
          (crossSession ? REPEATED_COMMAND_CROSS_SESSION_BONUS : 0),
      ),
      createdAt,
    });
  }
}

function buildRepeatedCommandSummary(command: string, occurrence: CommandOccurrence): string {
  const scope = occurrence.sessionIds.size >= 2 ? `，跨 ${occurrence.sessionIds.size} 个会话` : "";
  return `高频命令：\`${command}\`（出现 ${occurrence.count} 次${scope}）`;
}

/**
 * 提取一段文本里的命令行。围栏内逐行识别；围栏外只认 `$ ` 提示符行与
 * 行内反引号代码两种低噪来源——普通散文里的裸命令名不计入。
 */
function extractCommandLines(text: string): string[] {
  const commands: string[] = [];
  let inFence = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      const command = normalizeCommandLine(line);
      if (command) commands.push(command);
      continue;
    }
    if (line.startsWith("$ ")) {
      const command = normalizeCommandLine(line.slice(2));
      if (command) commands.push(command);
      continue;
    }
    for (const inline of line.matchAll(/`([^`\n]+)`/gu)) {
      const command = normalizeCommandLine(inline[1] ?? "");
      if (command) commands.push(command);
    }
  }
  return commands;
}

/** 归一化一行候选命令：剥提示符、限长度、白名单校验、压缩空白。 */
function normalizeCommandLine(rawLine: string): string | undefined {
  let line = rawLine.trim();
  if (line.startsWith("$ ")) line = line.slice(2).trim();
  if (line.length < MIN_COMMAND_LENGTH || line.length > COMMAND_MAX_LENGTH) return undefined;
  if (line.includes("`")) return undefined;
  const firstToken = line.split(/\s+/u)[0];
  if (!firstToken || !KNOWN_COMMAND_TOKENS.has(firstToken)) return undefined;
  return line.replace(/\s+/gu, " ");
}

// ── 被用户采纳的修复模式 ───────────────────────────────────────

function collectAdoptedFixCandidates(
  sessions: readonly DistillSessionInput[],
  createdAt: string,
  emit: (candidate: DistillCandidate) => void,
): void {
  for (const session of sessions) {
    const fragments = session.fragments;
    let index = 0;
    while (index < fragments.length) {
      if (fragments[index].role !== "assistant") {
        index += 1;
        continue;
      }
      // 收集连续 assistant 回复组；"连续修复"取组内最后一个修复类叙述（最终状态）。
      const group: DistillSessionFragment[] = [];
      while (index < fragments.length && fragments[index].role === "assistant") {
        group.push(fragments[index]);
        index += 1;
      }
      const fixFragment = findLastFixLikeFragment(group);
      if (!fixFragment) continue;
      if (!hasUserConfirmationBeforeNextAssistant(fragments, index)) continue;

      const prose = stripCodeBlocks(fixFragment.text);
      const rootCause = ROOT_CAUSE_PATTERN.test(prose);
      const consecutiveFixes = group.length >= 2;
      emit({
        id: buildCandidateId("adopted-fix", `${session.sessionId}\u0000${prose}`),
        kind: "adopted-fix",
        summary: summarizeFixProse(prose),
        sourceSessionId: session.sessionId,
        confidence: clampConfidence(
          ADOPTED_FIX_BASE_CONFIDENCE +
            (rootCause ? ADOPTED_FIX_ROOT_CAUSE_BONUS : 0) +
            (consecutiveFixes ? ADOPTED_FIX_CONSECUTIVE_ASSISTANT_BONUS : 0),
        ),
        createdAt,
      });
    }
  }
}

function findLastFixLikeFragment(
  group: readonly DistillSessionFragment[],
): DistillSessionFragment | undefined {
  for (let index = group.length - 1; index >= 0; index -= 1) {
    const prose = stripCodeBlocks(group[index].text);
    if (prose.length >= MIN_FIX_PROSE_LENGTH && FIX_LIKE_PATTERN.test(prose)) {
      return group[index];
    }
  }
  return undefined;
}

/** 确认语必须出现在下一组 assistant 回复之前，否则它属于后续轮次而非本次修复。 */
function hasUserConfirmationBeforeNextAssistant(
  fragments: readonly DistillSessionFragment[],
  fromIndex: number,
): boolean {
  for (let index = fromIndex; index < fragments.length; index += 1) {
    const fragment = fragments[index];
    if (fragment.role === "assistant") return false;
    if (fragment.role === "user" && isUserConfirmation(fragment.text)) return true;
  }
  return false;
}

function isUserConfirmation(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length <= USER_CONFIRMATION_MAX_LENGTH && USER_CONFIRMATION_PATTERN.test(trimmed);
}

/** 去掉围栏与行内代码，只留叙述文本：修复判定与摘要都以散文为准。 */
function stripCodeBlocks(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`[^`\n]*`/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function summarizeFixProse(prose: string): string {
  if (prose.length === 0) return "(无叙述文本的修复)";
  const firstSentence = prose.split(/(?<=[。！？!?])/u)[0] ?? prose;
  return truncate(firstSentence.trim(), SUMMARY_MAX_LENGTH);
}

// ── 共用工具 ───────────────────────────────────────────────────

function buildCandidateId(kind: DistillCandidate["kind"], key: string): string {
  const digest = createHash("sha256").update(`${kind}\u0000${key}`).digest("hex").slice(0, 12);
  return `distill-${kind}-${digest}`;
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function clampConfidence(value: number): number {
  // 加成项是十进制小数，浮点累加会引入尾差；取整到千分位让公式结果稳定可比。
  return Math.round(Math.min(Math.max(value, 0), CONFIDENCE_MAX) * 1000) / 1000;
}

function defaultNow(): Date {
  return new Date();
}
