import { BookOpenIcon } from "lucide-react";
import type { WikiCatalogNode } from "@/lib/repoWiki.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export type RepoWikiPageStatus = "generating" | "waiting" | "failed";

/**
 * Repo Wiki 目录树：分组节点渲染为小节标题（不可选中），页面节点渲染为
 * 「标题 + description 副标题」两行条目；生成中的页面带状态行并置灰不可选
 * （官方工作台同款：进行中「正在生成」、未完成「等待生成」、失败「生成失败」）。
 */
export function RepoWikiCatalogTree({
  nodes,
  activePageId,
  pageStatusById,
  depth = 0,
  onSelect,
}: {
  nodes: WikiCatalogNode[];
  activePageId: string | null;
  /** 页面 id → 生成状态；无条目 = 已完成（正常可读）。 */
  pageStatusById: Map<string, RepoWikiPageStatus>;
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
        return (
          <div key={node.id}>
            {page ? (
              <button
                type="button"
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
            ) : (
              <div
                style={indent}
                className="px-2 pb-0.5 pt-3 text-ui-xs font-medium tracking-wide text-foreground-subtlest"
              >
                <span className="block truncate">{node.title}</span>
              </div>
            )}
            {node.children.length > 0 ? (
              <RepoWikiCatalogTree
                nodes={node.children}
                activePageId={activePageId}
                pageStatusById={pageStatusById}
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
