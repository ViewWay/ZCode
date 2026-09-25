import type { EditorInfo, OpenInEditorRemoteTarget } from "@zcode/shared";
import type { IDisposable } from "@zcode/rpc";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { WorkspaceFileGitStatus, WorkspaceFileTreeRow } from "@/workspace-file-tree/model.js";

export interface WorkspaceFileTreeProps {
  workspacePath: string;
  workspaceName?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  revealPath?: string;
  temporaryExternalDirectory?: boolean;
  canOpenLocalFileManager?: boolean;
  activePreviewPath?: string | null;
  /** 打开 Repo Wiki 主工作台（官方文档入口：文件树顶部仓库名旁的图标）。 */
  onOpenRepoWiki?: () => void;
  onClose: () => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenPreview?: (source: CodeViewerSource) => void;
}

export interface WorkspaceFileTreeWatcherRegistration {
  id: string;
  subscription: IDisposable;
  unwatch: () => Promise<void>;
}

export interface WorkspaceFileTreeStickyFolderItem {
  row: WorkspaceFileTreeRow;
  index: number;
}

export interface WorkspaceFileTreeContextMenuLabels {
  addToChat: string;
  copyAbsolutePath: string;
  copyRelativePath: string;
  open: string;
  openInBrowser: string;
  openFailed: string;
  openWith: string;
  reveal: string;
}

export interface WorkspaceFileTreeEditorState {
  canOpenLocalFileManager: boolean;
  installedEditors: EditorInfo[];
  isRemoteWorkspaceFileTree: boolean;
  remoteTarget?: OpenInEditorRemoteTarget;
}

export type WorkspaceFileGitStatusLabels = Record<WorkspaceFileGitStatus, string>;
