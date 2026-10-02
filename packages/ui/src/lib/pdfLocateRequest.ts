/**
 * PDF 预览联动（specs/pdf-preview-linkage.md）的纯派生逻辑。
 *
 * 中立模块（模式同 presentFilesCards）：只做数据整形，不含 JSX、不依赖 store，
 * 供 ToolCallBlocks renderer 与测试共用。pdf_locate 不新增协议事件——工具调用记录
 * 本身就是定位指令载体：input 携带 file/snippet/page，output（模型回显文本）携带
 * core 匹配器给出的权威 status+page（文本由 @zcode/shared parsePdfLocateModelText
 * 解析，句式两端以单测锚定）。
 */
import { PDF_LOCATE_TOOL_NAME, parsePdfLocateModelText, type PdfLocateStatus } from "@zcode/shared";
// 相对导入（不用 @/ 别名）：本模块要能被 node:test + tsx 直接加载做纯函数单测。
import { getPathLeaf } from "./path.js";

/** UI 消费一次 pdf_locate 定位所需的全部信息。 */
export interface PdfLocateRequest {
  /** 宿主本地绝对路径（工具入参 file；打开预览与匹配 pending 的键）。 */
  filePath: string;
  /** 预览展示名（路径叶子）。 */
  fileName: string;
  /** 逐字引用的片段；文本层匹配用于高亮，匹配不到只翻页。 */
  snippet: string;
  /** 目标页（1-indexed）。优先取回显权威页（匹配页可能与入参 page 不同）。 */
  page: number;
  /** core 匹配器结论；output 未到达时为 null（流式早期不定位）。 */
  status: PdfLocateStatus | null;
}

export function isPdfLocateToolName(toolName: string | null | undefined): boolean {
  return toolName?.trim().toLowerCase() === PDF_LOCATE_TOOL_NAME;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * 从工具调用宽容读取定位请求。
 * - 名字不认领 / input 无合法 file → null（挂起卡由 renderer 兜底）。
 * - output 解析成功 → status+权威页；解析失败但调用已完成 → 入参 page（或第 1 页）
 *   的降级定位（与 core 的 file_opened 语义对齐：无页码打开首页）。
 * - output 缺席（流式/未完成）→ null：等回显到位再定位，避免翻两次页。
 */
export function readPdfLocateRequest(input: {
  toolName?: string | null;
  kind?: string | null;
  status?: string | null;
  input?: unknown;
  output?: unknown;
}): PdfLocateRequest | null {
  if (!isPdfLocateToolName(input.toolName) && !isPdfLocateToolName(input.kind)) {
    return null;
  }

  const rawInput = isRecord(input.input) ? input.input : {};
  const filePath = typeof rawInput.file === "string" && rawInput.file.trim() ? rawInput.file : null;
  if (!filePath) {
    return null;
  }
  const snippet =
    typeof rawInput.snippet === "string" && rawInput.snippet.trim() ? rawInput.snippet : "";
  const inputPage = readPositiveInt(rawInput.page);

  const outputText = typeof input.output === "string" ? input.output : null;
  if (outputText === null) {
    return null;
  }
  const parsed = parsePdfLocateModelText(outputText);
  if (parsed) {
    return {
      filePath,
      fileName: getPathLeaf(filePath),
      snippet,
      page: parsed.page,
      status: parsed.status,
    };
  }
  if (input.status !== "completed") {
    return null;
  }
  // 回显不可解析（版本差/格式漂移）但调用已完成：按入参页降级，保证至少翻页。
  return {
    filePath,
    fileName: getPathLeaf(filePath),
    snippet,
    page: inputPage ?? 1,
    status: null,
  };
}
