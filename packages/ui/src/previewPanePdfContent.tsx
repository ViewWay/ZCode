import { Suspense, lazy } from "react";
import type { PdfViewerLabels, PdfViewerSource } from "@/components/ui/pdf-viewer.js";
import type { PdfLocateViewerLocate } from "@/pdf/PdfLocateViewer.js";

// react-pdf（含 pdf.js 与 worker）体积较大，懒加载让它只在首次打开 PDF 预览时进入 bundle，
// 不拖慢没有用到 PDF 的会话的启动。渲染走 pdf_locate 定位可用查看器
// （packages/ui/src/pdf/PdfLocateViewer.tsx，specs/pdf-preview-linkage.md）：
// 无 locate 时与旧查看器等价；PreviewPane 消费 pdfLocateStore 的 pending 后传入。
const PdfLocateViewer = lazy(() =>
  import("@/pdf/PdfLocateViewer.js").then((module) => ({
    default: module.PdfLocateViewer,
  })),
);

interface PdfPreviewContentProps {
  source: PdfViewerSource;
  labels: PdfViewerLabels;
  /** pdf_locate 定位请求；null 为普通预览形态。 */
  locate?: PdfLocateViewerLocate | null;
}

export function PdfPreviewContent({ source, labels, locate }: PdfPreviewContentProps) {
  return (
    <Suspense
      fallback={<div className="p-3 text-ui-base text-foreground-subtle">{labels.loading}</div>}
    >
      <PdfLocateViewer source={source} labels={labels} className="h-full" locate={locate} />
    </Suspense>
  );
}
