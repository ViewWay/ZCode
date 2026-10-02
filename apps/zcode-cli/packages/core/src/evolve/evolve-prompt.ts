// ============================================================
// /evolve 内置命令 —— 会话级自进化回合（参考 MiMo evolve-seed 三主体架构）
// ============================================================
//
// 手动 /evolve 在主循环里以普通权限跑三阶段反思提示词：主 Agent 回顾行为
// 与结果、反思我核对「说的 vs 发生的」（链路闭合检查）、超我做长周期方向
// 校准；产出追加到工作区 .zcode/evolve/GROWTH.md 成长记录。与 MiMo 的
// 常驻 Python harness 相比，v1 是单会话顺序化：不做代码自改写、不做常驻
// 心跳、不做独立克隆工作区。

export interface EvolvePromptInput {
  /** 工作区根目录；undefined = 无工作区，提示词降级需要 open workspace。 */
  workspaceRoot: string | undefined;
  /** 项目记忆根目录（可选）；存在时把可长期化的教训写入记忆。 */
  memoryRoot?: string;
  /** "/evolve <focus>" 的可选焦点指引。 */
  instructions?: string;
}

export function buildEvolvePrompt(input: EvolvePromptInput): string {
  if (input.workspaceRoot === undefined) {
    return [
      "# Evolve: Session Self-Evolution Cycle",
      "",
      "The /evolve command was invoked without a workspace, so there is nothing to reflect on.",
      "",
      "Reply with one short sentence stating that /evolve requires an open workspace, then stop. The /evolve turn does not use any tools.",
    ].join("\n");
  }

  const workspaceRoot = input.workspaceRoot;
  const memoryRoot = input.memoryRoot;
  const focus = input.instructions?.trim();
  const memoryLine =
    memoryRoot === undefined
      ? 'Long-term lessons MAY be written to project memory if your system prompt provides a memory directory; otherwise keep lessons in GROWTH.md only.'
      : 'Long-term lessons MAY also be written as memory files under `' + memoryRoot + '/` per your Memory section format.';
  const lines: string[] = [
    '# Evolve: Session Self-Evolution Cycle',
    '',
    'You are running one evolution cycle over your own recent work in this workspace. Three perspectives run in order: the Main agent (what happened), the Reflector (what it means), and the Superego (where this is heading).',
    '',
    'Workspace: `' + workspaceRoot + '`',
    'Growth log: `' + workspaceRoot + '/.zcode/evolve/GROWTH.md` (create if missing; append, do not rewrite history)',
    '',
    '---',
    '',
    '## Phase 1 — Main agent: review what happened',
    '',
    '- Reconstruct the recent work record: `git -C ' + workspaceRoot + ' log --oneline -20` and `git -C ' + workspaceRoot + ' status --short`.',
    '- For each meaningful change: what was attempted vs what actually happened (built? tested? verified?).',
    '- Note unfinished threads and dead ends worth recording.',
    '',
    '## Phase 2 — Reflector: verify claims against reality',
    '',
    '- For every claim of completion, verify like a skeptic: does the code exist? do tests cover it? is the chain closed end-to-end (producer, state, consumer)?',
    '- List mismatches between what was said and what is real; each becomes a correction item.',
    '- Identify repeated mistakes or wasted actions across recent turns; extract each lesson in one sentence.',
    '',
    '## Phase 3 — Superego: calibrate direction',
    '',
    '- Read the last entries of the growth log; look for drift signals: low-value churn, idle loops, wandering away from the workspace goal.',
    '- State whether recent work serves a long-horizon goal; if not, name the correction in one sentence.',
    '- Keep it honest and short. Calibration notes are direction, not blame.',
    '',
    '## Phase 4 — Record',
    '',
    '- Append one entry to `' + workspaceRoot + '/.zcode/evolve/GROWTH.md` with today\'s absolute date (ISO `YYYY-MM-DD`), three short sections matching the phases, and any correction items.',
    memoryLine,
    '- If nothing changed (no new lessons, direction on track), append a one-line "no-op" entry and say so.',
    '',
    '---',
    '',
    'Return a brief summary: what was verified, what corrections were found, and the direction verdict. If nothing changed, say so.',
  ];
  const body = lines.join('\n');
  return focus === undefined ? body : body + '\n\n## Focus\n\n' + focus;
}
