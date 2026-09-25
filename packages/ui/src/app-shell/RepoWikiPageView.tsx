import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import type { WikiPage, WikiPageSource } from "@/lib/repoWiki.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 右栏页面正文：标题 + 描述 + markdown（mermaid/源码链接由 MessageResponse 渲染）
 * + 来源清单（path:line 跳 code-viewer）。
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
  const pageSources = page.sources ?? [];

  return (
    <>
      <h1 className="mb-2 text-ui-xl font-semibold text-foreground">{page.title}</h1>
      {page.description ? (
        <p className="mb-4 text-ui-sm leading-5 text-foreground-subtle">{page.description}</p>
      ) : null}
      <MessageResponse
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        workspaceRemoteSessionId={workspaceRemoteSessionId}
        onOpenFileLink={onOpenCodeViewer}
        onOpenExternalUrl={(url) => onOpenBrowserUrl?.(url)}
      >
        {page.markdown}
      </MessageResponse>
      {pageSources.length > 0 ? (
        <div className="mt-6 border-t border-border pt-3">
          <div className="pb-1.5 text-ui-xs font-medium uppercase tracking-wide text-foreground-subtlest">
            {intl.formatMessage({ id: "repoWiki.sources" })}
          </div>
          <div className="flex flex-col items-start gap-1">
            {pageSources.map((source) => (
              <button
                key={`${source.path}:${source.startLine ?? 0}`}
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
    </>
  );
}
