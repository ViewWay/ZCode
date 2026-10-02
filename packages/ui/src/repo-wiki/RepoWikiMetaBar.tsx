import { ChevronDownIcon, ChevronRightIcon, GitBranchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { WikiGenerationProgress } from "./analysis.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 标题区（官方布局）：项目名 + 可折叠「元数据」（分支/语言/更新时间/提交 ID/文件数）；
 * 生成中追加状态条（正在分析代码库 / 正在生成页面 done/total + 进度条 + 当前页名）。
 * 元数据取数（提交 ID / 文件数）由本组件自理：只有标题区消费这两个值，
 * 收在视图内部避免 workbench 为展示细节持有取数状态。
 */
export function RepoWikiMetaBar({
  repoName,
  workspacePath,
  branchName,
  languageLabel,
  updatedAtLabel,
  isGitRepository,
  progress,
  currentPageTitle,
  analyzing,
}: {
  repoName: string;
  workspacePath: string;
  /** git 分支名（非 git 仓库为 null，隐藏分支/提交展示）。 */
  branchName: string | null;
  languageLabel: string;
  updatedAtLabel: string;
  isGitRepository: boolean;
  /** 非 null = 正在生成页面（进度条 + done/total）；null 且 analyzing = 正在分析代码库。 */
  progress: WikiGenerationProgress | null;
  /** 目录序第一个未完成页的标题（progress 非 null 时展示）。 */
  currentPageTitle: string | null;
  analyzing: boolean;
}) {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const [metadataExpanded, setMetadataExpanded] = useState(false);
  const [headCommitId, setHeadCommitId] = useState<string | null>(null);
  const [wikiFileCount, setWikiFileCount] = useState<number | null>(null);

  // 元数据取数：分支名来自 gitSummary（workbench 既有数据），提交 ID 与文件数在此按需拉取。
  useEffect(() => {
    let cancelled = false;
    if (isGitRepository) {
      void services.gitService
        .getCommitGraph({ workspacePath, maxCount: 1 })
        .then((result) => {
          if (!cancelled) setHeadCommitId(result.commits[0]?.hash.slice(0, 11) ?? null);
        })
        .catch(() => {});
    } else {
      setHeadCommitId(null);
    }
    void services.fileService
      .listWorkspaceFilesLength({ rootPath: workspacePath })
      .then((count) => {
        if (!cancelled && Number.isFinite(count)) setWikiFileCount(count);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isGitRepository, services, workspacePath]);

  return (
    <div className="shrink-0 border-b border-border px-4 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-ui-base font-semibold text-foreground">
          {repoName}
        </span>
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
          {headCommitId ? (
            <span className="font-mono">
              {intl.formatMessage({ id: "repoWiki.meta.commit" })}: {headCommitId}
            </span>
          ) : null}
          {wikiFileCount !== null ? (
            <span>
              {intl.formatMessage({ id: "repoWiki.meta.files" })}: {wikiFileCount}
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
              style={{
                width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%`,
              }}
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
