import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { getPathLeaf } from "@/lib/path.js";
import type { FileExplorerSidePaneTab } from "@/lib/workspaceSidePane.js";
import { WorkspaceFileTree } from "@/WorkspaceFileTree.js";

interface FileExplorerSidePaneProps {
  tab: FileExplorerSidePaneTab;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  isDesktop?: boolean;
  onClose: () => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenPreview: (source: CodeViewerSource) => void;
}

/**
 * 侧边面板「文件」tab：复用左侧栏同源的 WorkspaceFileTree，
 * 选中文件经 onOpenPreview 以 code-viewer 标签页打开（与文件树滑出层同一条链路）。
 */
export function FileExplorerSidePane({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  isDesktop,
  onClose,
  onOpenBrowserUrl,
  onOpenPreview,
}: FileExplorerSidePaneProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      <WorkspaceFileTree
        workspacePath={workspacePath}
        workspaceName={getPathLeaf(workspacePath)}
        workspaceIdentity={workspaceIdentity}
        workspaceRemoteSessionId={workspaceRemoteSessionId}
        canOpenLocalFileManager={isDesktop}
        onClose={onClose}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenPreview={onOpenPreview}
      />
    </div>
  );
}
