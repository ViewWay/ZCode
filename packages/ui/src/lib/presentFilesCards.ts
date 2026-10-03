/**
 * 交付物卡片（present_files）的纯派生逻辑（specs/deliverable-cards.md）。
 *
 * 中立模块（模式同 codePreviewSettings / assistantPreviewCards）：只做数据
 * 整形与匹配，不含 JSX、不依赖 store，供 ToolCallBlocks renderer 与测试共用。
 * present_files 是纯声明工具：输入 files 是模型声明，输出 accepted 是 handler
 * 的路径回显；卡片取两者中更可信的一份（完成态用 accepted，流式用 input）。
 */
import { PRESENT_FILES_TOOL_NAME } from "@zcode/shared";
// 相对导入（不用 @/ 别名）：本模块要能被 node:test + tsx 直接加载做纯函数单测。
import { getPathLeaf } from "./path.js";

/** UI 渲染一张交付物卡片所需的全部信息。 */
export interface PresentFilesCard {
  id: string;
  /** 宿主本地绝对路径；点击后走 media-preview 打开路径。 */
  path: string;
  /** 卡片主标题：文件名（路径叶子）。 */
  fileName: string;
}

/** present_files 工具调用的展示投影。 */
export interface PresentFilesDeclaration {
  /** 展示用路径清单：完成态取 output.accepted（handler 去重保序），否则取 input.files。 */
  files: string[];
  /** 模型附注；仅来自 input.note。 */
  note?: string;
  /** 工具调用是否已成功完成（有 accepted 回显）。 */
  completed: boolean;
}

export function isPresentFilesToolName(toolName: string | null | undefined): boolean {
  return toolName?.trim().toLowerCase() === PRESENT_FILES_TOOL_NAME;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) continue;
    paths.push(item);
  }
  return paths;
}

/**
 * 从工具调用的 input/output 宽容读取交付物声明。
 * 返回 null 表示这不是一次可展示的 present_files 调用（无合法路径）。
 * 流式期间 input 可能未完整到达，逐字段宽容解析，不做 schema 强校验。
 */
export function readPresentFilesDeclaration(input: {
  toolName?: string | null;
  kind?: string | null;
  title?: string | null;
  input?: unknown;
  output?: unknown;
}): PresentFilesDeclaration | null {
  if (!isPresentFilesToolName(input.toolName)) {
    return null;
  }

  const rawInput = isRecord(input.input) ? input.input : {};
  const note =
    typeof rawInput.note === "string" && rawInput.note.trim() ? rawInput.note : undefined;

  const outputAccepted = isRecord(input.output) ? readStringArray(input.output.accepted) : null;
  if (outputAccepted && outputAccepted.length > 0) {
    return { files: outputAccepted, note, completed: true };
  }

  const declaredFiles = readStringArray(rawInput.files) ?? [];
  if (declaredFiles.length === 0) {
    return null;
  }
  return { files: declaredFiles, note, completed: false };
}

/** 把声明投影为卡片列表（去重保序，与 handler 回显语义一致）。 */
export function buildPresentFilesCards(declaration: PresentFilesDeclaration): PresentFilesCard[] {
  const seen = new Set<string>();
  const cards: PresentFilesCard[] = [];
  for (const path of declaration.files) {
    if (seen.has(path)) continue;
    seen.add(path);
    cards.push({ id: path, path, fileName: getPathLeaf(path) });
  }
  return cards;
}

/** 卡片点击打开预览的 CodeViewerSource（走 media-preview 打开路径）。 */
export function buildPresentFilesCardPreviewSource(
  card: PresentFilesCard,
  workspacePath?: string,
): {
  type: "file";
  title: string;
  path: string;
  workspacePath?: string;
} {
  return {
    type: "file",
    title: card.fileName,
    path: card.path,
    ...(workspacePath ? { workspacePath } : {}),
  };
}
