import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePanelRef } from "react-resizable-panels";
import {
  ArrowLeftIcon,
  BookOpenIcon,
  ChevronRightIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import type { GitRepositorySummary } from "@zcode/shared";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { getPathLeaf } from "@/lib/path.js";
import { analyzeWikiDocument, getWikiPageNeighbors } from "./analysis.js";
import { buildRepoWikiGeneratePrompt, type WikiPageSource } from "./model.js";
import { Button } from "@/components/ui/button.js";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable.js";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useRepoWikiGeneration } from "./useRepoWikiGeneration.js";
import { useRepoWikiGenerationStatus } from "./useRepoWikiGenerationStatus.js";
import { useRepoWikiSelection, useRepoWikiWorkspace } from "./useRepoWikiWorkspace.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { RepoWikiCatalogPane } from "./RepoWikiCatalogPane.js";
import { RepoWikiEmptyState } from "./RepoWikiEmptyState.js";
import { RepoWikiGenerationOptions } from "./RepoWikiGenerationOptions.js";
import { RepoWikiMetaBar } from "./RepoWikiMetaBar.js";
import { RepoWikiPageNav } from "./RepoWikiPageNav.js";
import { RepoWikiPageView } from "./RepoWikiPageView.js";
import { useRepoWikiGenerationOptions } from "./useRepoWikiGenerationOptions.js";

interface RepoWikiWorkbenchProps {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  /** 主区视图激活（非设置覆盖）时才轮询 wiki.json。 */
  active?: boolean;
  /** git 摘要（元数据的分支名）；非 git 仓库隐藏分支/提交。 */
  gitSummary?: GitRepositorySummary | null;
  onExit: () => void;
  onOpenCodeViewer: (source: CodeViewerSource) => void;
  onOpenBrowserUrl?: (url: string) => void;
}

/**
 * Repo Wiki 主工作台（对齐官方「仓库 Wiki」，docs: zcode.z.ai/cn/docs/repo-wiki）：
 * 顶栏按生成状态门控（生成中仅「停止」），标题区含可折叠元数据与生成进度条，
 * 目录面板可拖宽/可收起、页面带生成状态；数据在 ~/.zcode/v2/repo-wiki/<hash>/wiki.json。
 */
export function RepoWikiWorkbench({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  active = true,
  gitSummary = null,
  onExit,
  onOpenCodeViewer,
  onOpenBrowserUrl,
}: RepoWikiWorkbenchProps) {
  const { intl, locale } = useZCodeIntl();
  const services = useServices();
  const confirmDialog = useConfirmDialog();
  const repoName = getPathLeaf(workspacePath);
  const wiki = useRepoWikiWorkspace(services, {
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    active,
  });
  const { start: startGeneration, stop: stopGeneration, pending: generationPending } =
    useRepoWikiGeneration(services);
  const { selectedPageId, selectPage } = useRepoWikiSelection(wiki.catalog);

  // ── 生成状态（磁盘推导 + 登记表；spec「生成状态机」）──
  // 单遍扫描统一派生（v7）：进度 + 未完成页状态 + 失败计数 + 可读页目录序。
  const analysis = useMemo(
    () => analyzeWikiDocument(wiki.doc, wiki.catalog),
    [wiki.doc, wiki.catalog],
  );
  const progress = analysis.progress;
  // 用户点过「停止」后本轮不再视为生成中，直到再次点生成。
  const [userStoppedGeneration, setUserStoppedGeneration] = useState(false);
  const { generating, generationBusy } = useRepoWikiGenerationStatus({
    wikiPhase: wiki.phase,
    progress,
    userStoppedGeneration,
    generationPending,
    scope: {
      workspacePath,
      workspaceIdentity,
      remoteSessionId: workspaceRemoteSessionId,
    },
  });

  // ── 生成选项（视图态，不持久化）──
  const { generationOptions, wikiLanguage, modelOverride, retryPerPage, generateDiagrams } =
    useRepoWikiGenerationOptions({
      workspacePath,
      workspaceIdentity,
      workspaceRemoteSessionId,
      locale,
    });

  const wikiHomePath = wiki.homePath;
  const wikiWorkspaceHash = wiki.workspaceHash;
  const generateDisabled = generationBusy || wiki.phase === "resolving";
  const [deleting, setDeleting] = useState(false);
  const selectedPage = useMemo(
    () => wiki.doc?.pages.find((page) => page.id === selectedPageId) ?? null,
    [selectedPageId, wiki.doc],
  );

  const handleGenerate = useCallback(() => {
    if (!wikiHomePath || !wikiWorkspaceHash) return;
    setUserStoppedGeneration(false);
    void startGeneration(
      {
        workspacePath,
        workspaceIdentity,
        remoteSessionId: workspaceRemoteSessionId,
        ...(modelOverride ? { modelSelection: modelOverride } : {}),
      },
      buildRepoWikiGeneratePrompt(
        {
          homePath: wikiHomePath,
          workspaceHash: wikiWorkspaceHash,
          workspacePath,
          language: wikiLanguage,
          generateDiagrams,
          retryPerPage,
        },
        repoName,
      ),
    ).then((result) => {
      toast(
        intl.formatMessage({
          id: result.ok ? "repoWiki.generationStarted" : "repoWiki.generationFailed",
        }),
      );
    });
  }, [
    generateDiagrams,
    intl,
    modelOverride,
    repoName,
    retryPerPage,
    startGeneration,
    wikiHomePath,
    wikiLanguage,
    wikiWorkspaceHash,
    workspaceIdentity,
    workspacePath,
    workspaceRemoteSessionId,
  ]);

  const handleStopGeneration = useCallback(() => {
    // 先翻本地状态让 UI 立即转空闲；已完成页面保留在磁盘。
    setUserStoppedGeneration(true);
    void stopGeneration({
      workspacePath,
      workspaceIdentity,
      remoteSessionId: workspaceRemoteSessionId,
    });
  }, [stopGeneration, workspaceIdentity, workspacePath, workspaceRemoteSessionId]);

  const handleDeleteWiki = useCallback(async () => {
    const wikiJsonPath = wiki.wikiJsonPath;
    if (!wikiJsonPath) return;
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "repoWiki.delete.title" }),
      description: intl.formatMessage({ id: "repoWiki.delete.description" }, { path: wikiJsonPath }),
      confirmLabel: intl.formatMessage({ id: "repoWiki.delete.confirm" }),
      cancelLabel: intl.formatMessage({ id: "repoWiki.delete.cancel" }),
    });
    if (!confirmed) return;
    setDeleting(true);
    try {
      await services.fileService.deleteFile({ path: wikiJsonPath });
      // 删除成功立即重读（spec v5）：不等下一轮轮询，随即回到空态卡片。
      wiki.refresh();
      toast(intl.formatMessage({ id: "repoWiki.deleted" }));
    } catch {
      toast(intl.formatMessage({ id: "repoWiki.deleteFailed" }));
    } finally {
      setDeleting(false);
    }
  }, [confirmDialog, intl, services, wiki.refresh, wiki.wikiJsonPath]);

  const handleOpenFileLink = useCallback(
    (target: MessageFileLinkTarget) => {
      onOpenCodeViewer({
        type: "file",
        title: getPathLeaf(target.path),
        path: target.path,
        workspacePath,
        workspaceIdentity,
        workspaceRemoteSessionId,
      });
    },
    [workspacePath, workspaceIdentity, workspaceRemoteSessionId],
  );

  // 引用稳定回调（v7 性能不变量）：inline 箭头会打断 RepoWikiPageView 内
  // MessageResponse 的深度 memo，导致整页 markdown 随本组件任意状态变化全量重渲。
  const handleOpenSource = useCallback(
    (source: WikiPageSource) => {
      onOpenCodeViewer({
        type: "file",
        title: getPathLeaf(source.path),
        path: source.path,
        workspacePath,
        workspaceIdentity,
        workspaceRemoteSessionId,
      });
    },
    [workspacePath, workspaceIdentity, workspaceRemoteSessionId],
  );

  // 页面状态：磁盘事实（analysis.pendingStatusById，单遍扫描产出）+ 视图态重标注——
  // 用户停止后首个未完成页展示为「等待生成」而非「正在生成」（仅改标签不改成员，
  // 未完成页两种标签下都置灰不可选）。
  const pageStatusById = useMemo(() => {
    if (generating || !progress || progress.generatingPageId === null) {
      return analysis.pendingStatusById;
    }
    const remapped = new Map(analysis.pendingStatusById);
    remapped.set(progress.generatingPageId, "waiting");
    return remapped;
  }, [analysis, generating, progress]);
  const failedPageCount = analysis.failedPageCount;
  const currentPageTitle =
    wiki.doc?.pages.find((page) => page.id === progress?.generatingPageId)?.title ?? null;

  // 上一页/下一页（spec v3「正文阅读」）：仅在已完成页面（目录深度优先序）间跳转。
  const { prevPage, nextPage } = useMemo(
    () => getWikiPageNeighbors(wiki.doc, analysis.readablePageIds, selectedPageId),
    [analysis, selectedPageId, wiki.doc],
  );

  // 切页正文回顶（spec v3）：长页底部切页不残留旧偏移。
  const contentViewRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    contentViewRef.current?.scrollTo({ top: 0 });
  }, [selectedPageId]);

  const languageLabel = (lang: "zh-CN" | "en-US"): string =>
    intl.formatMessage({ id: lang === "zh-CN" ? "repoWiki.language.zhCN" : "repoWiki.language.enUS" });
  const docUpdatedAt = wiki.doc && wiki.doc.updatedAt > 0 ? wiki.doc.updatedAt : null;
  const selectedPagePending = selectedPage ? pageStatusById.has(selectedPage.id) : false;

  // 目录面板可拖宽 + 可整体收起（「项目」头的收起柄 / 折叠后的左侧展开柄）。
  const catalogPanelRef = usePanelRef();
  const [catalogCollapsed, setCatalogCollapsed] = useState(false);

  const isGitRepository = gitSummary?.isRepository === true;
  const showMetaBar = wiki.phase === "ready" || generating;
  const selectedPageView = selectedPage && !selectedPagePending ? selectedPage : null;

  return (
    <main className="flex h-full min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <Button type="button" size="xs" variant="ghost" onClick={onExit}>
          <ArrowLeftIcon className="size-3.5" />
          {intl.formatMessage({ id: "repoWiki.backToChat" })}
        </Button>
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-ui-sm text-foreground-subtle">
          <BookOpenIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{repoName}</span>
          <span className="text-foreground-subtlest">/</span>
          <span className="shrink-0">{intl.formatMessage({ id: "repoWiki.wikiTitle" })}</span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {generating ? (
            <Button type="button" size="xs" variant="outline" onClick={handleStopGeneration}>
              {intl.formatMessage({ id: "repoWiki.stop" })}
            </Button>
          ) : wiki.phase === "ready" ? (
            <>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={handleDeleteWiki}
                disabled={deleting}
                className="text-foreground-subtle hover:text-foreground"
              >
                <Trash2Icon className="size-3.5" />
                {intl.formatMessage({ id: "repoWiki.delete" })}
              </Button>
              <Button size="xs" variant="outline" onClick={handleGenerate} disabled={generateDisabled}>
                <RefreshCwIcon className="size-3.5" />
                {intl.formatMessage({ id: "repoWiki.regenerate" })}
              </Button>
              <RepoWikiGenerationOptions {...generationOptions} />
            </>
          ) : null}
        </div>
      </div>
      {showMetaBar ? (
        <RepoWikiMetaBar
          repoName={repoName}
          workspacePath={workspacePath}
          branchName={isGitRepository ? (gitSummary?.branchName ?? null) : null}
          languageLabel={languageLabel(wiki.doc?.language ?? wikiLanguage)}
          updatedAtLabel={docUpdatedAt ? new Date(docUpdatedAt).toLocaleString() : "—"}
          isGitRepository={isGitRepository}
          progress={generating ? progress : null}
          currentPageTitle={currentPageTitle}
          analyzing={generating && !wiki.doc}
        />
      ) : null}
      {wiki.phase === "ready" ? (
        <div className="relative min-h-0 flex-1">
          <ResizablePanelGroup
            orientation="horizontal"
            layoutId={`repo-wiki-layout:${workspaceIdentity?.trim() || workspacePath}`}
            panelIds={["repo-wiki-catalog", "repo-wiki-content"]}
            className="h-full min-h-0"
          >
            <ResizablePanel
              id="repo-wiki-catalog"
              panelRef={catalogPanelRef}
              defaultSize="24%"
              minSize="16%"
              collapsedSize="0"
              collapsible
              onResize={() => setCatalogCollapsed(catalogPanelRef.current?.isCollapsed() ?? false)}
            >
              <RepoWikiCatalogPane
                catalog={wiki.catalog}
                activePageId={selectedPageId}
                pageStatusById={pageStatusById}
                failedPageCount={failedPageCount}
                onSelect={selectPage}
                onCollapse={() => catalogPanelRef.current?.collapse()}
              />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="repo-wiki-content" minSize="40%">
              <div ref={contentViewRef} className="h-full min-w-0 overflow-y-auto px-6 py-5">
                {selectedPageView ? (
                  <>
                    <RepoWikiPageView
                      page={selectedPageView}
                      workspacePath={workspacePath}
                      workspaceIdentity={workspaceIdentity}
                      workspaceRemoteSessionId={workspaceRemoteSessionId}
                      onOpenCodeViewer={handleOpenFileLink}
                      onOpenSource={handleOpenSource}
                      onOpenBrowserUrl={onOpenBrowserUrl}
                    />
                    <RepoWikiPageNav
                      prevPage={prevPage}
                      nextPage={nextPage}
                      onSelect={selectPage}
                    />
                  </>
                ) : selectedPagePending ? (
                  <div className="flex h-full items-center justify-center text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({ id: "repoWiki.pageStatus.generating" })}
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({ id: "repoWiki.selectPage" })}
                  </div>
                )}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
          {catalogCollapsed ? (
            <button
              type="button"
              className="absolute left-0 top-1/2 z-10 flex h-12 w-5 -translate-y-1/2 items-center justify-center rounded-r-md border border-l-0 border-border bg-surface text-foreground-subtlest hover:text-foreground"
              title={intl.formatMessage({ id: "repoWiki.catalog.expand" })}
              onClick={() => catalogPanelRef.current?.expand()}
            >
              <ChevronRightIcon className="size-3.5" />
            </button>
          ) : null}
        </div>
      ) : (
        <RepoWikiEmptyState
          generateDisabled={generateDisabled}
          onGenerate={handleGenerate}
          generationOptions={generationOptions}
          invalidExistingWiki={wiki.invalid}
        />
      )}
    </main>
  );
}
