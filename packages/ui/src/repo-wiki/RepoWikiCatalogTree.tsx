import { BookOpenIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { WikiPageStatus } from "./analysis.js";
import type { WikiCatalogNode } from "./model.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 目录条目状态标签（v7：联合类型移入 model.ts，与 analyzeWikiDocument 共用一份）。 */
export type RepoWikiPageStatus = WikiPageStatus;

/**
 * Repo Wiki 目录树：分组节点渲染为可折叠小节标题（默认展开，点击切换；
 * 展开态由外层传入的 collapsedGroupIds 持有——过滤激活时外层传空集合，
 * 直接展示全部命中路径，spec v4），页面节点渲染为「标题 + description 副标题」
 * 两行条目；生成中的页面带状态行并置灰不可选（官方工作台同款：进行中「正在生成」、
 * 未完成「等待生成」、失败「生成失败」）。
 * 页面条目带 data-page-id：供目录滚动容器定位当前选中页。
 */
export function RepoWikiCatalogTree({
  nodes,
  activePageId,
  pageStatusById,
  collapsedGroupIds,
  onToggleGroup,
  depth = 0,
  onSelect,
}: {
  nodes: WikiCatalogNode[];
  activePageId: string | null;
  /** 页面 id → 生成状态；无条目 = 已完成（正常可读）。 */
  pageStatusById: Map<string, RepoWikiPageStatus>;
  /** 已收起的分组节点 id 集合（视图态，外层持有）。 */
  collapsedGroupIds: ReadonlySet<string>;
  onToggleGroup: (groupId: string) => void;
  depth?: number;
  onSelect: (pageId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <>
      {nodes.map((node) => {
        const page = node.page;
        const indent = { paddingInlineStart: `${8 + depth * 12}px` };
        const status = page ? (pageStatusById.get(page.id) ?? null) : null;
        // 折叠仅作用于分组节点（page=null）；页面节点带 children 时（兜底挂载）
        // 与旧行为一致始终展开渲染。
        const isCollapsed = page === null && collapsedGroupIds.has(node.id);
        return (
          <div key={node.id}>
            {page ? (
              <button
                type="button"
                data-page-id={page.id}
                aria-current={page.id === activePageId ? "page" : undefined}
                onClick={() => onSelect(page.id)}
                disabled={status !== null}
                style={indent}
                className={cn(
                  "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 pr-2 text-left transition-colors",
                  status === null && "hover:bg-hover",
                  status === null
                    ? page.id === activePageId
                      ? "bg-selected text-foreground"
                      : "text-foreground-subtle hover:text-foreground"
                    : "text-foreground-subtlest",
                )}
              >
                <span className="flex w-full items-center gap-1.5 text-ui-sm">
                  <BookOpenIcon className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{page.title}</span>
                </span>
                {page.description ? (
                  <span className="block w-full truncate pl-5 text-ui-xs leading-4 text-foreground-subtlest">
                    {page.description}
                  </span>
                ) : null}
                {status ? (
                  <span className="block w-full truncate pl-5 text-ui-xs leading-4">
                    {intl.formatMessage({
                      id:
                        status === "generating"
                          ? "repoWiki.pageStatus.generating"
                          : status === "failed"
                            ? "repoWiki.pageStatus.failed"
                            : "repoWiki.pageStatus.waiting",
                    })}
                  </span>
                ) : null}
              </button>
            ) : node.children.length > 0 ? (
              <button
                type="button"
                style={indent}
                aria-expanded={!collapsedGroupIds.has(node.id)}
                onClick={() => onToggleGroup(node.id)}
                className="flex w-full items-center gap-1 px-2 pb-0.5 pt-3 text-left text-ui-xs font-medium tracking-wide text-foreground-subtlest transition-colors hover:text-foreground"
              >
                {collapsedGroupIds.has(node.id) ? (
                  <ChevronRightIcon className="size-3 shrink-0" />
                ) : (
                  <ChevronDownIcon className="size-3 shrink-0" />
                )}
                <span className="min-w-0 truncate">{node.title}</span>
              </button>
            ) : (
              // 无子节点的纯分组标题：保持原静态样式（无可折叠内容）。
              <div
                style={indent}
                className="px-2 pb-0.5 pt-3 text-ui-xs font-medium tracking-wide text-foreground-subtlest"
              >
                <span className="block truncate">{node.title}</span>
              </div>
            )}
            {node.children.length > 0 && !isCollapsed ? (
              <RepoWikiCatalogTree
                nodes={node.children}
                activePageId={activePageId}
                pageStatusById={pageStatusById}
                collapsedGroupIds={collapsedGroupIds}
                onToggleGroup={onToggleGroup}
                depth={depth + 1}
                onSelect={onSelect}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}
