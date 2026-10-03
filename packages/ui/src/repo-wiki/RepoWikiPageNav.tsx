import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { WikiPage } from "./model.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 页面底部「上一页 / 下一页」导航（spec v3「正文阅读」）：仅在已完成页面
 * （目录深度优先序）间跳转；首/末页对应侧渲染占位保持左右对齐。
 */
export function RepoWikiPageNav({
  prevPage,
  nextPage,
  onSelect,
}: {
  prevPage: WikiPage | null;
  nextPage: WikiPage | null;
  onSelect: (pageId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  if (!prevPage && !nextPage) return null;
  return (
    <div className="mt-8 flex items-stretch justify-between gap-3 border-t border-border pt-3">
      {prevPage ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="min-w-0 max-w-[48%]"
          onClick={() => onSelect(prevPage.id)}
        >
          <ChevronLeftIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            {intl.formatMessage({ id: "repoWiki.prevPage" })} {prevPage.title}
          </span>
        </Button>
      ) : (
        <span />
      )}
      {nextPage ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="min-w-0 max-w-[48%]"
          onClick={() => onSelect(nextPage.id)}
        >
          <span className="min-w-0 truncate">
            {intl.formatMessage({ id: "repoWiki.nextPage" })} {nextPage.title}
          </span>
          <ChevronRightIcon className="size-3.5 shrink-0" />
        </Button>
      ) : (
        <span />
      )}
    </div>
  );
}
