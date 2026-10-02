// ============================================================
// /dream 内置命令 —— 记忆巩固提示词（参考 cc-haha autoDream/consolidationPrompt）
// ============================================================
//
// 手动 /dream 在主循环里以普通权限运行四阶段巩固提示词（定向/收集/巩固/修剪）：
// 修正偏移的记忆、把新信号合并进既有主题文件、相对日期转绝对、删除被证伪的旧事实、
// 把 MEMORY.md 索引压回单行指针列表。时间/会话数门控与 fork+锁是 autoDream
// 自动版的机制，本 v1 不做。

export interface DreamPromptInput {
  /** 项目记忆根目录；undefined = 记忆未启用，提示词降级为「说明未启用并停止」。 */
  memoryRoot: string | undefined;
  /** 工作区根目录，供收集阶段与当前代码库状态对照。 */
  workspaceRoot?: string;
  /** "/dream <focus>" 的可选焦点指引。 */
  instructions?: string;
}

export function buildDreamPrompt(input: DreamPromptInput): string {
  if (input.memoryRoot === undefined) {
    return [
      "# Dream: Memory Consolidation",
      "",
      "The /dream command was invoked, but project memory is not enabled for this workspace, so there is no memory directory to consolidate.",
      "",
      "Reply with one short sentence stating that /dream requires project memory to be enabled for this workspace, then stop. The /dream turn does not use any tools.",
    ].join("\n");
  }

  const memoryRoot = input.memoryRoot;
  const workspaceRoot = input.workspaceRoot ?? "";
  const focus = input.instructions?.trim();
  const lines: string[] = [
    '# Dream: Memory Consolidation',
    '',
    'You are performing a dream — a reflective pass over your project memory. Synthesize what you have learned recently into durable, well-organized memories so future sessions can orient quickly.',
    '',
    'Memory directory: `' + memoryRoot + '/` (already exists — write files directly; do not run mkdir)',
    'Workspace under review: `' + workspaceRoot + '`',
    '',
    '---',
    '',
    '## Phase 1 — Orient',
    '',
    '- List the memory directory to see what already exists.',
    '- Read `MEMORY.md` — it is the index, one line per memory: `- [Title](file.md) — one-line hook`.',
    '- Skim existing topic files in ' + memoryRoot + ' so you improve them rather than creating near-duplicates.',
    '',
    '## Phase 2 — Gather recent signal',
    '',
    'Look for things worth persisting or correcting. Sources, in rough priority order:',
    '',
    '1. **Memories that drifted** — facts in existing memory files that contradict the current state of the workspace. Verify against the code and git history under `' + workspaceRoot + '` before editing.',
    '2. **Unsaved recent signal** — important conclusions, decisions, or user feedback from recent sessions that never made it into a memory file.',
    '3. **Weak or duplicate entries** — near-duplicate topic files that should be merged, or index lines carrying content that belongs in the topic file.',
    '',
    'Do not exhaustively re-read the whole workspace. Verify only what you already suspect matters.',
    '',
    '## Phase 3 — Consolidate',
    '',
    'For each thing worth remembering, write or update a memory file following the memory format from your system prompt\'s Memory section — one fact per file, frontmatter with name/description/metadata.type (user | feedback | project | reference), body states the fact (feedback/project add **Why:**/**How to apply:**), related memories linked with [[name]].',
    '',
    'Focus on:',
    '- Merging new signal into existing topic files rather than creating near-duplicates',
    '- Converting relative dates ("yesterday", "last week") to absolute dates so they remain interpretable later',
    '- Deleting contradicted facts at the source — if today\'s investigation disproves an old memory, fix the file, do not leave both versions',
    '',
    '## Phase 4 — Prune and index',
    '',
    'Keep `MEMORY.md` an index, not a dump:',
    '- One line per memory: `- [Title](file.md) — one-line hook`; never write memory content into it.',
    '- Remove pointers to memories that are now stale, wrong, or superseded.',
    '- Shorten index lines over ~150 characters — the detail belongs in the topic file.',
    '- Add pointers to newly important memories; resolve contradictions between files by fixing the wrong one.',
    '',
    '---',
    '',
    'Return a brief summary of what you consolidated, updated, or pruned. If nothing changed (memories are already tight), say so.',
  ];
  const body = lines.join('\n');
  return focus === undefined ? body : body + '\n\n## Focus\n\n' + focus;
}
