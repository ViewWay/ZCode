import {
  flattenWikiCatalogPageIds,
  REPO_WIKI_PAGE_FAILED_MARKER,
  REPO_WIKI_PAGE_PENDING_MARKER,
  type WikiCatalogNode,
  type WikiDocument,
  type WikiPage,
} from "./model.js";

export interface WikiGenerationProgress {
  /** 目录规划的总页数。 */
  total: number;
  /** 已完成（正文非占位/失败标记）的页数。 */
  done: number;
  /** 失败（FAILED 标记）页数。 */
  failed: number;
  /** 目录序第一个未完成页：UI 显示为「正在生成」。 */
  generatingPageId: string | null;
  /** 其余未完成页 id：目录显示「等待生成」。 */
  waitingPageIds: string[];
}

export type WikiPageStatus = "generating" | "waiting" | "failed";

interface WikiPageMarkerAnalysis {
  /** 生成进度（无未完成页时 null = 非生成中）。 */
  progress: WikiGenerationProgress | null;
  /** 全部未完成页的磁盘状态；「正在生成」= 目录序第一个非失败未完成页。 */
  pendingStatusById: Map<string, WikiPageStatus>;
  failedPageCount: number;
}

/**
 * 单遍扫描页面标记（v7 性能不变量）：进度、未完成页状态、失败计数一次遍历产出，
 * 每页 markdown 至多 trim 一次——此前 summarizeWikiGeneration 与视图层 pageStatusById
 * 各自全量扫描一遍。
 */
function analyzePageMarkers(doc: WikiDocument): WikiPageMarkerAnalysis {
  const pendingStatusById = new Map<string, WikiPageStatus>();
  // 「目录序」= order 升序（缺 order 兜底最大值），与旧 summarizeWikiGeneration 一致。
  const byOrder = [...doc.pages].sort(
    (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER),
  );
  let pendingCount = 0;
  let failedPageCount = 0;
  let generatingPageId: string | null = null;
  const waitingPageIds: string[] = [];
  for (const page of byOrder) {
    const trimmed = page.markdown.trim();
    if (trimmed === REPO_WIKI_PAGE_FAILED_MARKER) {
      pendingCount += 1;
      failedPageCount += 1;
      pendingStatusById.set(page.id, "failed");
      waitingPageIds.push(page.id);
      continue;
    }
    if (
      trimmed !== REPO_WIKI_PAGE_PENDING_MARKER &&
      trimmed !== `${REPO_WIKI_PAGE_PENDING_MARKER}…`
    ) {
      continue;
    }
    pendingCount += 1;
    if (generatingPageId === null) {
      generatingPageId = page.id;
      pendingStatusById.set(page.id, "generating");
      continue;
    }
    pendingStatusById.set(page.id, "waiting");
    waitingPageIds.push(page.id);
  }
  return {
    progress:
      pendingCount === 0
        ? null
        : {
            total: doc.pages.length,
            done: doc.pages.length - pendingCount,
            failed: failedPageCount,
            generatingPageId,
            waitingPageIds,
          },
    pendingStatusById,
    failedPageCount,
  };
}

export interface WikiDocumentAnalysis extends WikiPageMarkerAnalysis {
  /** 已完成（可读）页面 id 的目录深度优先序：上一页/下一页导航与默认选中依据。 */
  readablePageIds: string[];
}

/**
 * wiki.json 的统一派生入口：单遍扫描产出进度 + 未完成页状态 + 失败计数 + 可读页序。
 * pendingStatusById 是磁盘事实；「用户已停止」等视图态只重标注首个未完成页的
 * 标签（generating → waiting），不改变集合成员（可读性判断不受影响）。
 */
export function analyzeWikiDocument(
  doc: WikiDocument | null,
  catalog: WikiCatalogNode[],
): WikiDocumentAnalysis {
  if (!doc || doc.pages.length === 0) {
    return {
      progress: null,
      pendingStatusById: new Map(),
      failedPageCount: 0,
      readablePageIds: flattenWikiCatalogPageIds(catalog),
    };
  }
  const markers = analyzePageMarkers(doc);
  const readablePageIds = flattenWikiCatalogPageIds(catalog).filter(
    (pageId) => !markers.pendingStatusById.has(pageId),
  );
  return { ...markers, readablePageIds };
}

/**
 * 上一页/下一页（spec v3「正文阅读」）：在可读页目录序中定位当前页；
 * 端点、或当前页不在序内（未完成/未选中）时对应侧为 null。
 */
export function getWikiPageNeighbors(
  doc: WikiDocument | null,
  readablePageIds: string[],
  selectedPageId: string | null,
): { prevPage: WikiPage | null; nextPage: WikiPage | null } {
  const currentIndex = readablePageIds.indexOf(selectedPageId ?? "");
  const findPage = (pageId: string | undefined): WikiPage | null =>
    pageId ? (doc?.pages.find((page) => page.id === pageId) ?? null) : null;
  return {
    prevPage: currentIndex > 0 ? findPage(readablePageIds[currentIndex - 1]) : null,
    nextPage:
      currentIndex >= 0 && currentIndex < readablePageIds.length - 1
        ? findPage(readablePageIds[currentIndex + 1])
        : null,
  };
}

/**
 * 从磁盘 wiki.json 推导生成进度（纯函数）：done = 正文已就绪的页数，
 * generating = 目录序第一个未完成页。全部完成时返回 null（非生成中）。
 * 单遍扫描实现见 analyzePageMarkers（v7）；保留此入口兼容旧调用方与单测。
 */
export function summarizeWikiGeneration(doc: WikiDocument | null): WikiGenerationProgress | null {
  if (!doc || doc.pages.length === 0) return null;
  return analyzePageMarkers(doc).progress;
}
