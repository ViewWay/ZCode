import { create } from "zustand";

/**
 * 文件编辑草稿的唯一所有者，key 是 code-viewer tab id。
 * 磁盘文件仍是内容事实源；这里只保存「已加载基线 → 用户草稿」的编辑会话，
 * 让 tab 切换（内容组件卸载重挂）不丢草稿。tab 关闭时调用 discardDraft 清理。
 */
export interface FileEditorState {
  /** 进入编辑时的文件内容基线，用于脏状态判定。 */
  baseline: string;
  draft: string;
  saving: boolean;
  error: string | null;
}

interface FileEditorStoreState {
  editorsByTabId: Record<string, FileEditorState>;
  startEditing: (tabId: string, baseline: string) => void;
  updateDraft: (tabId: string, draft: string) => void;
  beginSave: (tabId: string) => void;
  saveSucceeded: (tabId: string) => void;
  saveFailed: (tabId: string, error: string) => void;
  discardDraft: (tabId: string) => void;
}

export const useFileEditorStore = create<FileEditorStoreState>((set) => ({
  editorsByTabId: {},
  startEditing: (tabId, baseline) => {
    set((state) => ({
      editorsByTabId: {
        ...state.editorsByTabId,
        [tabId]: { baseline, draft: baseline, saving: false, error: null },
      },
    }));
  },
  updateDraft: (tabId, draft) => {
    set((state) => {
      const editor = state.editorsByTabId[tabId];
      if (!editor) return state;
      return {
        editorsByTabId: {
          ...state.editorsByTabId,
          [tabId]: { ...editor, draft, error: null },
        },
      };
    });
  },
  beginSave: (tabId) => {
    set((state) => {
      const editor = state.editorsByTabId[tabId];
      if (!editor) return state;
      return {
        editorsByTabId: {
          ...state.editorsByTabId,
          [tabId]: { ...editor, saving: true, error: null },
        },
      };
    });
  },
  saveSucceeded: (tabId) => {
    set((state) => {
      const editor = state.editorsByTabId[tabId];
      if (!editor) return state;
      return {
        editorsByTabId: {
          ...state.editorsByTabId,
          [tabId]: { ...editor, baseline: editor.draft, saving: false, error: null },
        },
      };
    });
  },
  saveFailed: (tabId, error) => {
    set((state) => {
      const editor = state.editorsByTabId[tabId];
      if (!editor) return state;
      return {
        editorsByTabId: {
          ...state.editorsByTabId,
          [tabId]: { ...editor, saving: false, error },
        },
      };
    });
  },
  discardDraft: (tabId) => {
    set((state) => {
      if (!(tabId in state.editorsByTabId)) return state;
      const nextEditors = { ...state.editorsByTabId };
      delete nextEditors[tabId];
      return { editorsByTabId: nextEditors };
    });
  },
}));

export function selectFileEditorState(
  state: FileEditorStoreState,
  tabId: string,
): FileEditorState | null {
  return state.editorsByTabId[tabId] ?? null;
}

export function isFileEditorDirty(editor: FileEditorState): boolean {
  return editor.draft !== editor.baseline;
}
