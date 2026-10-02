// ============================================================
// Present Files - present_files 工具 handler（交付物卡片）
// ============================================================
// specs/deliverable-cards.md：模型声明交付物文件，UI 渲染为可点击卡片。
// 纯声明工具：无 IO、无端口、无 gate——handler 只做入参校验与路径回显
// （去重保序），不读盘、不校验存在性、不产生任何副作用。文件是否真的
// 存在由 UI 卡片侧的 stat 校验兜底（同 AssistantPreviewCards 模式）。

import {
  PRESENT_FILES_TOOL_NAME,
  PresentFilesInputJsonSchema,
  PresentFilesInputSchema,
  PresentFilesOutputJsonSchema,
  PresentFilesOutputSchema,
  PRESENT_FILES_MODEL_BYTES,
  PRESENT_FILES_TIMEOUT_MS,
  type PresentFilesInput,
  type PresentFilesOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const PRESENT_FILES_DESCRIPTION = [
  "# present_files",
  "",
  "Declare the final deliverable files of the current task so they are shown as clickable cards in the chat.",
  "",
  "```json",
  '{ "files": ["/abs/path/report.html"], "note": "Weekly report" }',
  "```",
  "",
  "Call this ONLY for deliverables the user wants to keep or review (final reports, generated",
  "documents, exports). Do NOT call it for intermediate artifacts or dependencies you merely read.",
  "For interactive demos/simulations reply with a self-contained ```zwidget fenced HTML block",
  "instead of generating a temporary file.",
  "This tool never reads, writes or verifies files - it only declares them.",
].join("\n");

const presentFilesHandler: ToolHandler = async (input) => {
  const parsed = PresentFilesInputSchema.parse(input) as PresentFilesInput;
  // 去重保序回显：模型重复罗列同一文件时卡片只出现一次，且顺序与声明一致。
  const accepted = [...new Set(parsed.files)];
  return PresentFilesOutputSchema.parse({ accepted }) satisfies PresentFilesOutput;
};

function formatPresentFilesModelContent(output: unknown): string {
  const parsed = PresentFilesOutputSchema.safeParse(output);
  if (!parsed.success) return "present_files returned an invalid result.";
  const lines = parsed.data.accepted.map((path) => `- ${path}`);
  return `Presented ${parsed.data.accepted.length} deliverable file(s):\n${lines.join("\n")}`;
}

export const presentFilesToolEntry: ToolEntry = {
  capability: "Declare final deliverable files so the UI shows clickable cards for them",
  metadata: {
    name: PRESENT_FILES_TOOL_NAME,
    description: PRESENT_FILES_DESCRIPTION,
    modelInstructions: [
      "Use once per turn, after the deliverable files are fully written.",
      "Only include files the user asked for or clearly wants to keep.",
      "Use the zwidget fenced HTML block for interactive demos instead of temp files.",
    ],
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: PRESENT_FILES_TIMEOUT_MS,
    maxOutputBytes: PRESENT_FILES_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: presentFilesHandler,
  formatModelContent: formatPresentFilesModelContent,
  inputSchema: PresentFilesInputJsonSchema,
  outputSchema: PresentFilesOutputJsonSchema,
  runtimeInputSchema: PresentFilesInputSchema,
  runtimeOutputSchema: PresentFilesOutputSchema,
  permission: {
    permission: "task.present_files",
    reason: "present_files only declares deliverable paths for UI cards; no file access",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: PRESENT_FILES_MODEL_BYTES,
    maxModelBytes: PRESENT_FILES_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: PRESENT_FILES_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: PRESENT_FILES_TIMEOUT_MS,
    maxMs: PRESENT_FILES_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "present_files was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
