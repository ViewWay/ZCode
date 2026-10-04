/**
 * PDF 预览联动查看器（specs/pdf-preview-linkage.md）。
 *
 * packages/ui/src/components/ui/ 下的 PdfViewer 是三方目录（README 声明不可修改），
 * 且其 props 无定位 API。本组件在目录之外直接封装 react-pdf，承载 pdf_locate 的
 * 两个定位语义：
 * 1. 命令式翻页/滚动到页（必须项）：locate 变化时（文档已加载立即、未加载则
 *    在 onLoadSuccess 后应用）切页并把滚动容器归顶；
 * 2. 文本层高亮（尽力而为）：snippet 经 customTextRenderer 空白归一化逐项匹配，
 *    匹配不到保持仅翻页（高亮逻辑见 ./pdfLocateTextLayer.ts）。
 * 预览面板（previewPanePdfContent）与附件对话框（ChatMediaAttachmentPreviewDialog）
 * 都渲染本组件；无 locate 时与普通查看器等价（翻页/缩放/页码输入）。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ChevronLeftIcon, ChevronRightIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { isAppleKeyboardPlatform } from "@/lib/keyboardShortcuts.js";
import { createPdfJsDocumentOptions } from "@/lib/pdfJsAssets.js";
import { buildPdfLocateTextRenderer } from "@/pdf/pdfLocateTextLayer.js";
import type {
  PdfViewerLabels,
  PdfViewerRangeSource,
  PdfViewerSource,
} from "@/components/ui/pdf-viewer.js";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

// 缩放档位与三方查看器保持一致（components/ui/usePdfZoomOverlay.ts 的常量值），
// 切换组件不会让用户已经习惯的倍率档位跳变。
const DEFAULT_SCALE = 1;
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const ZOOM_STEP = 0.25;
const WHEEL_ZOOM_SENSITIVITY = 0.002;

// 与 service 层 readFileRange 的默认分段大小对齐（同三方查看器），一次 range 请求
// 对应一次 RPC 调用；关闭整档预取保持「只拉需要的页」。
const RANGE_CHUNK_BYTES = 256 * 1024;

// cMap 等静态资源按 Vite base 解析（Desktop file:// 与 Web 子路径部署各取所需）。
const DOCUMENT_OPTIONS = createPdfJsDocumentOptions(
  typeof import.meta.env?.BASE_URL === "string" ? import.meta.env.BASE_URL : "./",
  globalThis.location?.href ?? "http://localhost/",
);
const RANGE_DOCUMENT_OPTIONS = {
  ...DOCUMENT_OPTIONS,
  disableAutoFetch: true,
  disableStream: true,
  rangeChunkSize: RANGE_CHUNK_BYTES,
};

function isPdfViewerRangeSource(source: PdfViewerSource): source is PdfViewerRangeSource {
  return (
    typeof source === "object" &&
    source !== null &&
    "requestRange" in source &&
    typeof (source as PdfViewerRangeSource).requestRange === "function"
  );
}

class PdfViewerRangeTransport extends pdfjs.PDFDataRangeTransport {
  private readonly rangeSource: PdfViewerRangeSource;
  private readonly onRequestError: (error: Error) => void;

  constructor(rangeSource: PdfViewerRangeSource, onRequestError: (error: Error) => void) {
    super(rangeSource.totalBytes, rangeSource.initialData ?? null);
    this.rangeSource = rangeSource;
    this.onRequestError = onRequestError;
  }

  override requestDataRange(begin: number, end: number): void {
    this.rangeSource
      .requestRange(begin, end - begin)
      .then((chunk) => {
        this.onDataRange(begin, chunk);
      })
      .catch((error: unknown) => {
        this.onRequestError(error instanceof Error ? error : new Error(String(error)));
      });
  }
}

/** 一次定位请求：page 必到，snippet 尽力高亮；requestId 变化即视为新请求。 */
export interface PdfLocateViewerLocate {
  page: number;
  snippet?: string;
  requestId?: number;
}

type PdfDocumentFile = string | Blob | { data: Uint8Array } | { range: PdfViewerRangeTransport };

function normalizePdfSource(
  source: Exclude<PdfViewerSource, PdfViewerRangeSource>,
): PdfDocumentFile {
  if (typeof source === "string" || source instanceof Blob) {
    return source;
  }
  // pdf.js 会 transfer 走二进制数据导致原 buffer detached；复制一份保重复打开可用。
  if (source instanceof ArrayBuffer) {
    return { data: new Uint8Array(source.slice(0)) };
  }
  return { data: new Uint8Array(source) };
}

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export interface PdfLocateViewerProps extends HTMLAttributes<HTMLDivElement> {
  source: PdfViewerSource;
  labels?: Partial<PdfViewerLabels>;
  onLoadError?: (error: Error) => void;
  /** pdf_locate 定位请求；null/缺省为普通查看器形态。 */
  locate?: PdfLocateViewerLocate | null;
}

export function PdfLocateViewer({
  source,
  labels,
  onLoadError,
  locate,
  className,
  ...props
}: PdfLocateViewerProps) {
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [rangeError, setRangeError] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToTopRef = useRef(false);
  const numPagesRef = useRef<number | null>(null);
  const pendingLocatePageRef = useRef<number | null>(null);
  const onLoadErrorRef = useRef(onLoadError);
  onLoadErrorRef.current = onLoadError;

  const rangeTransport = useMemo(() => {
    if (!isPdfViewerRangeSource(source)) {
      return null;
    }
    return new PdfViewerRangeTransport(source, (error) => {
      setRangeError(true);
      onLoadErrorRef.current?.(error);
    });
  }, [source]);

  const file = useMemo<PdfDocumentFile>(() => {
    if (rangeTransport) {
      return { range: rangeTransport };
    }
    return normalizePdfSource(source as Exclude<PdfViewerSource, PdfViewerRangeSource>);
  }, [rangeTransport, source]);

  useEffect(() => {
    return () => {
      // 文档切换/卸载时中止 range 传输，让 pdf.js 停止等待未完成的分段请求。
      rangeTransport?.abort();
    };
  }, [rangeTransport]);

  useEffect(() => {
    setNumPages(null);
    numPagesRef.current = null;
    setPageNumber(1);
    setPageInput("1");
    setScale(DEFAULT_SCALE);
    setRangeError(false);
    pendingScrollToTopRef.current = false;
    pendingLocatePageRef.current = null;
    // 文档切换后同一 locate 需要重新应用（新文档的页码/文本层都是新的）。
    lastLocateKeyRef.current = null;
  }, [file]);

  const goToPage = useCallback(
    (target: number, options?: { scrollToTop?: boolean }) => {
      const total = numPagesRef.current;
      if (total === null) {
        return;
      }
      const clamped = Math.min(Math.max(1, Math.round(target)), total);
      setPageInput(String(clamped));
      if (clamped !== pageNumber) {
        pendingScrollToTopRef.current = options?.scrollToTop ?? true;
        setPageNumber(clamped);
      } else if (options?.scrollToTop) {
        scrollContainerRef.current?.scrollTo({ top: 0 });
      }
    },
    [pageNumber],
  );

  // 定位请求消费：已加载立即翻页；未加载记录 pending，等 onLoadSuccess 应用。
  // requestId 缺席时按 page+snippet 合成键；用去重键防止 goToPage 因页码变化重建
  // 身份后同一请求被重放（重放会把用户随后的滚动顶回页首）。
  const lastLocateKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!locate) {
      return;
    }
    const locateKey = String(locate.requestId ?? `${locate.page}:${locate.snippet ?? ""}`);
    if (lastLocateKeyRef.current === locateKey) {
      return;
    }
    lastLocateKeyRef.current = locateKey;
    if (numPagesRef.current === null) {
      pendingLocatePageRef.current = locate.page;
      return;
    }
    goToPage(locate.page);
  }, [locate, goToPage]);

  const textRenderer = useMemo(
    () => buildPdfLocateTextRenderer(locate?.snippet),
    [locate?.snippet, locate?.requestId],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).tagName === "INPUT") {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goToPage(pageNumber - 1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        goToPage(pageNumber + 1);
      }
    },
    [goToPage, pageNumber],
  );

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || numPages === null) {
      return;
    }
    const zoomWithAppleModifier = isAppleKeyboardPlatform();
    const handleWheelZoom = (event: WheelEvent) => {
      const zoomModifierPressed = zoomWithAppleModifier ? event.metaKey : event.ctrlKey;
      if (!zoomModifierPressed || event.deltaY === 0) {
        return;
      }
      // 修饰键 + 滚轮独占为缩放手势（原生非 passive 监听才能阻止页面滚动）。
      event.preventDefault();
      setScale((current) => clampScale(current * Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY)));
    };
    container.addEventListener("wheel", handleWheelZoom, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheelZoom);
    };
  }, [numPages]);

  const commitPageInput = useCallback(() => {
    const parsed = Number.parseInt(pageInput.trim(), 10);
    if (Number.isNaN(parsed)) {
      setPageInput(String(pageNumber));
      return;
    }
    goToPage(parsed);
  }, [goToPage, pageInput, pageNumber]);

  const controlsDisabled = numPages === null;

  return (
    <div
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className={cn("flex h-full min-h-0 flex-col outline-none", className)}
      {...props}
    >
      <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-max p-4">
          {rangeError ? (
            <div className="p-3 text-ui-base text-destructive">{labels?.loadError}</div>
          ) : (
            <Document
              file={file}
              options={rangeTransport ? RANGE_DOCUMENT_OPTIONS : DOCUMENT_OPTIONS}
              onLoadSuccess={(document) => {
                numPagesRef.current = document.numPages;
                setNumPages(document.numPages);
                const clamped = Math.min(pageNumber, document.numPages);
                setPageNumber(clamped);
                setPageInput(String(clamped));
                // 文档加载完成才应用 pending 定位（spec：打开即定位只翻一次页）。
                const pendingLocatePage = pendingLocatePageRef.current;
                pendingLocatePageRef.current = null;
                if (pendingLocatePage !== null) {
                  goToPage(pendingLocatePage);
                }
              }}
              onLoadError={onLoadError}
              loading={
                <div className="p-3 text-ui-base text-foreground-subtle">{labels?.loading}</div>
              }
              error={<div className="p-3 text-ui-base text-destructive">{labels?.loadError}</div>}
              noData={
                <div className="p-3 text-ui-base text-foreground-subtle">{labels?.noData}</div>
              }
            >
              <Page
                pageNumber={pageNumber}
                scale={scale}
                renderAnnotationLayer={false}
                onRenderSuccess={() => {
                  // 页渲染完成后才把滚动容器归顶：直接 scrollTop=0 会因 canvas
                  // 尚未布局而被后续布局顶回去（同三方查看器的处理顺序）。
                  if (pendingScrollToTopRef.current) {
                    pendingScrollToTopRef.current = false;
                    scrollContainerRef.current?.scrollTo({ top: 0 });
                  }
                }}
                className="shadow-md"
                {...(textRenderer ? { customTextRenderer: textRenderer } : {})}
              />
            </Document>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-center gap-1 border-t border-border px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={labels?.previousPage}
          disabled={controlsDisabled || pageNumber <= 1}
          onClick={() => goToPage(pageNumber - 1)}
        >
          <ChevronLeftIcon />
        </Button>
        <div className="flex items-center gap-1 text-ui-base text-foreground-subtle">
          <input
            value={pageInput}
            inputMode="numeric"
            disabled={controlsDisabled}
            aria-label={labels?.pageInput}
            onChange={(event) => setPageInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitPageInput();
              }
            }}
            onBlur={commitPageInput}
            className="h-6 w-10 rounded-md border border-input-border bg-input px-1 text-center text-ui-base text-foreground outline-none transition-colors hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused disabled:pointer-events-none disabled:opacity-50"
          />
          <span>/ {numPages ?? "-"}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={labels?.nextPage}
          disabled={controlsDisabled || numPages === null || pageNumber >= numPages}
          onClick={() => goToPage(pageNumber + 1)}
        >
          <ChevronRightIcon />
        </Button>

        <div className="mx-1 h-4 w-px bg-border" />

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={labels?.zoomOut}
          disabled={controlsDisabled || scale <= MIN_SCALE}
          onClick={() => setScale((current) => clampScale(current - ZOOM_STEP))}
        >
          <ZoomOutIcon />
        </Button>
        <span className="w-11 text-center text-ui-base text-foreground-subtle tabular-nums">
          {Math.round(scale * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={labels?.zoomIn}
          disabled={controlsDisabled || scale >= MAX_SCALE}
          onClick={() => setScale((current) => clampScale(current + ZOOM_STEP))}
        >
          <ZoomInIcon />
        </Button>
      </div>
    </div>
  );
}
