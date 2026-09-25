import { ChevronLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import type { WikiCatalogNode } from "@/lib/repoWiki.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  RepoWikiCatalogTree,
  type RepoWikiPageStatus,
} from "@/app-shell/RepoWikiCatalogTree.js";

/**
 * 目录面板内容（「项目」标签 + 失败计数 + 收起按钮 + 状态目录树）。
 * 面板尺寸/折叠由外层 ResizablePanel 控制，本组件只渲染面板内部。
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
  return (
    <aside className="flex h-full min-w-0 flex-col overflow-hidden border-r border-border">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="min-w-0 flex-1 truncate px-1 text-ui-xs font-medium uppercase tracking-wide text-foreground-subtlest">
          {intl.formatMessage({ id: "repoWiki.catalog" })}
        </span>
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
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <RepoWikiCatalogTree
          nodes={catalog}
          activePageId={activePageId}
          pageStatusById={pageStatusById}
          onSelect={onSelect}
        />
      </div>
    </aside>
  );
}
