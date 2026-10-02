import { ChevronDownIcon, ChevronRightIcon, ListTreeIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import {
  extractWikiPageOutline,
  type WikiPage,
  type WikiPageOutlineItem,
  type WikiPageSource,
} from "./model.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 右栏页面正文：标题 + 可折叠「本页大纲」（spec v5）+ 描述 + markdown
 * （mermaid/源码链接由 MessageResponse 渲染）+ 来源清单（path:line 跳 code-viewer）。
 */
export function RepoWikiPageView({
  page,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  onOpenCodeViewer,
  onOpenSource,
  onOpenBrowserUrl,
}: {
  page: WikiPage;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  onOpenCodeViewer: (target: MessageFileLinkTarget) => void;
  onOpenSource: (source: WikiPageSource) => void;
  onOpenBrowserUrl?: (url: string) => void;
}) {
  const { intl } = useZCodeIntl();
  // 派生计算 memo 化（v7 性能不变量）：outline 为整页逐行正则，此前任意重渲染
  // （如大纲展开/收起）都会全量重算三组派生。
  // sources 按条目内容去重：生成端偶发重复列出同一条出处，展示层收敛；
  // key 附带下标兜底（path+行区间相同仍可能重复出现，避免 React key 冲突）。
  const pageSources = useMemo(() => {
    const seen = new Set<string>();
    return (page.sources ?? []).filter((source) => {
      const dedupeKey = `${source.path}:${source.startLine ?? 0}:${source.endLine ?? 0}`;
      if (seen.has(dedupeKey)) return false;
      seen.add(dedupeKey);
      return true;
    });
  }, [page]);
  // 关键文件（spec v6）：schema 里的 filePaths 之前只在生成端使用，UI 从未呈现；
  // 以 `/` 结尾视为目录不渲染（Agent 偶发把目录也填进来，code-viewer 打不开目录）。
  const pageFiles = useMemo(
    () => (page.filePaths ?? []).filter((path) => !path.endsWith("/")),
    [page],
  );

  // ── 本页大纲（spec v5）──
  // 从 markdown 源提取 h2/h3（纯函数，跳过代码块）；点击后到渲染产物里找对应标题元素。
  // 大纲是派生视图（源=page.markdown），切页随内容重算，不持久化展开态。
  const outline = useMemo(() => extractWikiPageOutline(page.markdown), [page]);
  const [outlineExpanded, setOutlineExpanded] = useState(true);
  const pageRef = useRef<HTMLDivElement | null>(null);

  const scrollToOutlineItem = (item: WikiPageOutlineItem, itemIndex: number) => {
    const headings = pageRef.current?.querySelectorAll<HTMLElement>("h2, h3");
    if (!headings || headings.length === 0) return;
    // 先按标题文本精确匹配：渲染产物可能带锚点装饰，取同名标题中第 N 次出现
    // （N = 大纲里同标题前驱数），与 streamdown 的 DOM 顺序一致。
    const sameTitle = Array.from(headings).filter(
      (element) => element.textContent?.trim() === item.title,
    );
    if (sameTitle.length > 0) {
      const occurrence = outline.filter(
        (candidate, index) => candidate.title === item.title && index < itemIndex,
      ).length;
      const target = sameTitle[Math.min(occurrence, sameTitle.length - 1)];
      target?.scrollIntoView({ block: "start" });
      return;
    }
    // 文本匹配失败（渲染器改写了标题文本）时，若 DOM 标题总数与大纲一致，
    // 按文档序下标兜底；仍对不上则放弃滚动（不误导用户）。
    if (headings.length === outline.length) {
      headings[itemIndex]?.scrollIntoView({ block: "start" });
    }
  };

  // 引用稳定回调（v7 性能不变量）：MessageResponse 的 memo 比较函数逐引用比较
  // onOpenExternalUrl，inline 箭头会让整页 markdown 随本组件任意状态变化全量重渲。
  const openExternalUrl = useCallback(
    (url: string) => {
      onOpenBrowserUrl?.(url);
    },
    [onOpenBrowserUrl],
  );

  return (
    <div ref={pageRef}>
      <h1 className="mb-2 text-ui-xl font-semibold text-foreground">{page.title}</h1>
      {page.description ? (
        <p className="mb-4 text-ui-sm leading-5 text-foreground-subtle">{page.description}</p>
      ) : null}
      {pageFiles.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <span className="text-ui-xs font-medium uppercase tracking-wide text-foreground-subtlest">
            {intl.formatMessage({ id: "repoWiki.files" })}
          </span>
          {pageFiles.map((path) => (
            <button
              key={path}
              type="button"
              className="max-w-full truncate rounded-md border border-border bg-surface px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground"
              onClick={() => onOpenSource({ path })}
            >
              {path}
            </button>
          ))}
        </div>
      ) : null}
      {outline.length >= 2 ? (
        <div className="mb-5 rounded-lg border border-border bg-surface px-3 py-2">
          <button
            type="button"
            aria-expanded={outlineExpanded}
            className="flex w-full items-center gap-1.5 text-ui-xs font-medium uppercase tracking-wide text-foreground-subtlest transition-colors hover:text-foreground"
            onClick={() => setOutlineExpanded((expanded) => !expanded)}
          >
            {outlineExpanded ? (
              <ChevronDownIcon className="size-3 shrink-0" />
            ) : (
              <ChevronRightIcon className="size-3 shrink-0" />
            )}
            <ListTreeIcon className="size-3 shrink-0" />
            {intl.formatMessage({ id: "repoWiki.outline" })}
          </button>
          {outlineExpanded ? (
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {outline.map((item, index) => (
                <li key={`${item.level}:${item.title}:${index}`}>
                  <button
                    type="button"
                    style={{ paddingInlineStart: item.level === 3 ? "16px" : "4px" }}
                    className={cn(
                      "block w-full truncate rounded-sm py-0.5 pr-2 text-left text-ui-xs transition-colors",
                      item.level === 2
                        ? "text-foreground-subtle hover:text-foreground"
                        : "text-foreground-subtlest hover:text-foreground",
                    )}
                    onClick={() => scrollToOutlineItem(item, index)}
                  >
                    {item.title}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <MessageResponse
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        workspaceRemoteSessionId={workspaceRemoteSessionId}
        onOpenFileLink={onOpenCodeViewer}
        onOpenExternalUrl={openExternalUrl}
      >
        {page.markdown}
      </MessageResponse>
      {pageSources.length > 0 ? (
        <div className="mt-6 border-t border-border pt-3">
          <div className="pb-1.5 text-ui-xs font-medium uppercase tracking-wide text-foreground-subtlest">
            {intl.formatMessage({ id: "repoWiki.sources" })}
          </div>
          <div className="flex flex-col items-start gap-1">
            {pageSources.map((source, index) => (
              <button
                key={`${source.path}:${source.startLine ?? 0}:${source.endLine ?? 0}:${index}`}
                type="button"
                className="font-mono text-ui-xs text-icon-blue hover:underline"
                onClick={() => onOpenSource(source)}
              >
                {source.path}
                {source.startLine ? `:${source.startLine}` : ""}
                {source.endLine ? `-${source.endLine}` : ""}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
