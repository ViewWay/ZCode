import { ChevronLeftIcon, SearchIcon, XIcon } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  filterWikiCatalogTree,
  flattenWikiCatalogPageIds,
  type WikiCatalogNode,
} from "./model.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { RepoWikiCatalogTree, type RepoWikiPageStatus } from "./RepoWikiCatalogTree.js";

const NO_COLLAPSED_GROUPS: ReadonlySet<string> = new Set();

/**
 * 目录面板内容（「项目」标签 + 失败计数 + 收起按钮 + 目录过滤 + 可折叠状态目录树）。
 * 面板尺寸/折叠由外层 ResizablePanel 控制，本组件只渲染面板内部。
 * 过滤与分组折叠均为视图态（spec v4）：不持久化、不落盘；过滤激活时忽略折叠状态，
 * 直接展示全部命中路径。选中页变化时滚动容器自动定位到当前条目（block=nearest）。
 */
export function RepoWikiCatalogPane({
  catalog,
  activePageId,
  pageStatusById,
  failedPageCount,
  onSelect,
  onCollapse,
}: {
  catalog: WikiCatalogNode[];
  activePageId: string | null;
  pageStatusById: Map<string, RepoWikiPageStatus>;
  failedPageCount: number;
  onSelect: (pageId: string) => void;
  onCollapse: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [filterQuery, setFilterQuery] = useState("");
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<ReadonlySet<string>>(new Set());
  const filteredCatalog = useMemo(
    () => filterWikiCatalogTree(catalog, filterQuery),
    [catalog, filterQuery],
  );
  const filtering = filterQuery.trim().length > 0;
  const effectiveCollapsedGroups = filtering ? NO_COLLAPSED_GROUPS : collapsedGroupIds;
  // 键盘路径（spec v5）：Enter 选中过滤结果里的第一个页面（目录深度优先序），
  // Escape 清空关键词。无可匹配项时两键都不动作。
  // 过滤结果单次扁平化（v7 性能不变量）：首命中页与面板头命中计数共用同一次
  // 深度优先遍历，此前对同一 filteredCatalog 各扫一遍。
  const filteredPageIds = useMemo(
    () => flattenWikiCatalogPageIds(filteredCatalog),
    [filteredCatalog],
  );
  const firstFilteredPageId = filteredPageIds[0] ?? null;
  const handleFilterKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && firstFilteredPageId) {
      onSelect(firstFilteredPageId);
      return;
    }
    if (event.key === "Escape" && filtering) {
      event.stopPropagation();
      setFilterQuery("");
    }
  };

  const toggleGroup = (groupId: string) => {
    setCollapsedGroupIds((previous) => {
      const next = new Set(previous);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  // 选中页变化时定位当前条目：block=nearest 只在条目不在视口内时滚动，
  // 不打断用户正在进行的滚动。过滤/折叠导致条目暂不可见时无副作用。
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!activePageId) return;
    const item = listRef.current?.querySelector(`[data-page-id="${CSS.escape(activePageId)}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [activePageId]);

  // 过滤命中页数（正文/标题/描述匹配的总页数）：过滤激活时展示在面板头。
  const filteredPageCount = filteredPageIds.length;

  return (
    <aside className="flex h-full min-w-0 flex-col overflow-hidden border-r border-border">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="min-w-0 flex-1 truncate px-1 text-ui-xs font-medium uppercase tracking-wide text-foreground-subtlest">
          {intl.formatMessage({ id: "repoWiki.catalog" })}
        </span>
        {filtering ? (
          <span className="shrink-0 text-ui-xs text-foreground-subtlest">
            {intl.formatMessage(
              { id: "repoWiki.catalog.matchCount" },
              { count: filteredPageCount },
            )}
          </span>
        ) : null}
        {failedPageCount > 0 ? (
          <span className="shrink-0 text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "repoWiki.failedCount" }, { count: failedPageCount })}
          </span>
        ) : null}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title={intl.formatMessage({ id: "repoWiki.catalog.collapse" })}
          onClick={onCollapse}
        >
          <ChevronLeftIcon className="size-3.5" />
        </Button>
      </div>
      {catalog.length > 0 ? (
        <div className="px-2 pb-1 pt-1.5">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtlest" />
            <Input
              size="sm"
              value={filterQuery}
              onChange={(event) => setFilterQuery(event.target.value)}
              onKeyDown={handleFilterKeyDown}
              placeholder={intl.formatMessage({ id: "repoWiki.catalog.filterPlaceholder" })}
              className="pr-6 pl-7"
            />
            {filtering ? (
              <button
                type="button"
                className="absolute right-1 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center rounded-sm text-foreground-subtlest hover:text-foreground"
                title={intl.formatMessage({ id: "repoWiki.catalog.clearFilter" })}
                onClick={() => setFilterQuery("")}
              >
                <XIcon className="size-3" />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
        {filtering && filteredCatalog.length === 0 ? (
          <p className="px-2 py-4 text-center text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "repoWiki.catalog.noMatches" })}
          </p>
        ) : (
          <RepoWikiCatalogTree
            nodes={filteredCatalog}
            activePageId={activePageId}
            pageStatusById={pageStatusById}
            collapsedGroupIds={effectiveCollapsedGroups}
            onToggleGroup={toggleGroup}
            onSelect={onSelect}
          />
        )}
      </div>
    </aside>
  );
}
