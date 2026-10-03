/**
 * PDF 预览联动（specs/pdf-preview-linkage.md）的 pending 定位请求。
 *
 * 状态所有者：pdf_locate 工具卡（生产者，工具完成时 publish 一次）→ 本 store（瞬态
 * pending，窗口生命周期，不持久化）→ PreviewPane（消费者，打开的 PDF 路径与请求
 * 匹配时 consume 清空）。工具事件只是输入，本 store 是定位请求在 renderer 内的唯一
 * 传递通道，不新建协议事件（specs/pdf-preview-linkage.md 的「定位事件链」）。
 */
import { create } from "zustand";
import type { PdfLocateRequest } from "@/lib/pdfLocateRequest.js";

export interface PdfLocatePendingRequest extends PdfLocateRequest {
  /** 单调递增请求序号：消费方用同一份请求对象做依赖，重放可被识别。 */
  requestId: number;
}

interface PdfLocateStoreState {
  pending: PdfLocatePendingRequest | null;
  /** 发布定位请求；后到覆盖先到（模型连续引用时以最后一次回答为准）。 */
  publish: (request: PdfLocateRequest) => void;
  /**
   * 消费与打开文件匹配的 pending；不匹配（预览开着别的文件/未开）保留，
   * 等待预览切换到目标文件后由下一次匹配消费。
   */
  consume: (filePath: string) => PdfLocatePendingRequest | null;
  clear: () => void;
}

let nextRequestId = 1;

export const usePdfLocateStore = create<PdfLocateStoreState>((set, get) => ({
  pending: null,
  publish: (request) => {
    set({ pending: { ...request, requestId: nextRequestId++ } });
  },
  consume: (filePath) => {
    const pending = get().pending;
    if (!pending || !isSamePdfPath(pending.filePath, filePath)) {
      return null;
    }
    set({ pending: null });
    return pending;
  },
  clear: () => {
    set({ pending: null });
  },
}));

/**
 * 路径匹配键：工具入参是绝对路径，预览打开的也是绝对路径；容忍结尾分隔符与
 * 大小写差异（Windows/macOS 路径大小写语义都不严格），不做其他归一化——
 * 跨 workspace 的远程路径解析归既有 media-preview 打开路径负责。
 */
export function isSamePdfPath(a: string, b: string): boolean {
  const normalize = (value: string) => value.trim().replace(/[\\/]+$/, "");
  return normalize(a).toLowerCase() === normalize(b).toLowerCase();
}
