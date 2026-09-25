import { ChevronDownIcon, ChevronRightIcon, GitBranchIcon } from "lucide-react";
import { useState } from "react";
import type { WikiGenerationProgress } from "@/lib/repoWiki.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 标题区（官方布局）：项目名 + 可折叠「元数据」（分支/语言/更新时间/提交 ID/文件数）；
 * 生成中追加状态条（正在分析代码库 / 正在生成页面 done/total + 进度条 + 当前页名）。
 */
export function RepoWikiMetaBar({
  repoName,
  branchName,
  languageLabel,
  updatedAtLabel,
  commitId,
  fileCount,
  progress,
  currentPageTitle,
  analyzing,
}: {
  repoName: string;
  branchName: string | null;
  languageLabel: string;
  updatedAtLabel: string;
  commitId: string | null;
  fileCount: number | null;
  /** 非 null = 正在生成页面（进度条 + done/total）；null 且 analyzing = 正在分析代码库。 */
  progress: WikiGenerationProgress | null;
  /** 目录序第一个未完成页的标题（progress 非 null 时展示）。 */
  currentPageTitle: string | null;
  analyzing: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [metadataExpanded, setMetadataExpanded] = useState(false);

  return (
    <div className="shrink-0 border-b border-border px-4 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-ui-base font-semibold text-foreground">{repoName}</span>
        <button
          type="button"
          className="flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-ui-xs text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground"
          onClick={() => setMetadataExpanded((expanded) => !expanded)}
        >
          {intl.formatMessage({ id: "repoWiki.meta.badge" })}
          {metadataExpanded ? (
            <ChevronDownIcon className="size-3" />
          ) : (
            <ChevronRightIcon className="size-3" />
          )}
        </button>
      </div>
      {metadataExpanded ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-ui-xs text-foreground-subtle">
          {branchName ? (
            <span className="flex items-center gap-1 font-mono">
              <GitBranchIcon className="size-3.5" />
              {branchName}
            </span>
          ) : null}
          <span>
            {intl.formatMessage({ id: "repoWiki.meta.language" })}: {languageLabel}
          </span>
          <span>
            {intl.formatMessage({ id: "repoWiki.meta.updatedAt" })}: {updatedAtLabel}
          </span>
          {commitId ? (
            <span className="font-mono">
              {intl.formatMessage({ id: "repoWiki.meta.commit" })}: {commitId}
            </span>
          ) : null}
          {fileCount !== null ? (
            <span>
              {intl.formatMessage({ id: "repoWiki.meta.files" })}: {fileCount}
            </span>
          ) : null}
        </div>
      ) : null}
      {progress ? (
        <div className="mt-1.5">
          <div className="flex items-center justify-between text-ui-xs text-foreground-subtle">
            <span>{intl.formatMessage({ id: "repoWiki.progress.pages" })}</span>
            <span className="font-mono">
              {progress.done}/{progress.total}
            </span>
          </div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500"
              style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
            />
          </div>
          {currentPageTitle ? (
            <p className="mt-1 truncate text-ui-xs text-foreground-subtlest">{currentPageTitle}</p>
          ) : null}
        </div>
      ) : analyzing ? (
        <p className="mt-1 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "repoWiki.progress.analyzing" })}
        </p>
      ) : null}
    </div>
  );
}
