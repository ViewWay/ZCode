import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import {
  buildWikiCatalogTree,
  computeWorkspaceWikiHash,
  getRepoWikiJsonPath,
  normalizeWikiDocument,
  type WikiCatalogNode,
  type WikiDocument,
} from "@/lib/repoWiki.js";
import { useWorkspaceHomePath } from "@/hooks/useWorkspaceHomePath.js";

const POLL_INTERVAL_MS = 2500;

export type RepoWikiPhase = "resolving" | "missing" | "ready";

export interface UseRepoWikiWorkspaceParams {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  /** 视图激活时才轮询；非激活挂起。 */
  active?: boolean;
}

export interface RepoWikiWorkspaceState {
  phase: RepoWikiPhase;
  homePath?: string;
  workspaceHash?: string;
  wikiJsonPath?: string;
  doc: WikiDocument | null;
  catalog: WikiCatalogNode[];
  refresh: () => void;
}

/**
 * Repo Wiki 数据层：轮询读取 `~/.zcode/v2/repo-wiki/<hash>/wiki.json`
 * （磁盘为唯一事实源），派生目录树。生成由后台任务完成，本 hook 只读。
 */
export function useRepoWikiWorkspace(
  services: IServiceAccessor,
  params: UseRepoWikiWorkspaceParams,
): RepoWikiWorkspaceState {
  const { homePath, workspaceHash, wikiJsonPath, doc, catalog, phase, refresh } =
    useRepoWikiWorkspaceInner(services, params);
  return { phase, homePath, workspaceHash, wikiJsonPath, doc, catalog, refresh };
}

function useRepoWikiWorkspaceInner(
  services: IServiceAccessor,
  params: UseRepoWikiWorkspaceParams,
): RepoWikiWorkspaceState {
  const active = params.active ?? true;
  // home 目录解析复用既有 useWorkspaceHomePath（systemService.info().homedir，带跨视图缓存）。
  const homePath = useWorkspaceHomePath({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity ?? null,
    remoteSessionId: params.workspaceRemoteSessionId ?? null,
  });
  const [workspaceHash, setWorkspaceHash] = useState<string | null>(null);
  const [doc, setDoc] = useState<WikiDocument | null>(null);
  const [phase, setPhase] = useState<RepoWikiPhase>("resolving");
  const [refreshTick, setRefreshTick] = useState(0);
  const loadGenerationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setWorkspaceHash(null);
    setDoc(null);
    setPhase("resolving");
    if (!homePath || !params.workspacePath) {
      return;
    }
    void (async () => {
      const hash = await computeWorkspaceWikiHash(params.workspacePath);
      if (cancelled) return;
      setWorkspaceHash(hash);
    })();
    return () => {
      cancelled = true;
    };
  }, [homePath, params.workspacePath]);

  const refresh = useCallback(() => {
    setRefreshTick((tick) => tick + 1);
  }, []);

  const wikiJsonPath = useMemo(
    () => (homePath && workspaceHash ? getRepoWikiJsonPath(homePath, workspaceHash) : null),
    [homePath, workspaceHash],
  );

  useEffect(() => {
    if (!wikiJsonPath || !params.workspacePath) {
      return;
    }
    let cancelled = false;
    const load = async () => {
      const generation = ++loadGenerationRef.current;
      try {
        // 先做存在性检查：空态（尚未生成）是常规路径，避免每 2.5s 在宿主日志刷 ENOENT。
        const existence = await services.fileService.checkFilesExist({
          paths: [wikiJsonPath],
        });
        if (cancelled || generation !== loadGenerationRef.current) return;
        if (!existence[0]?.exists) {
          setPhase("missing");
          setDoc(null);
          return;
        }
        const result = await services.fileService.readTextFile({
          path: wikiJsonPath,
          offset: 0,
          length: 4 * 1024 * 1024,
        });
        if (cancelled || generation !== loadGenerationRef.current) return;
        if (result.isBinary || result.truncated || !result.content) {
          setPhase("missing");
          setDoc(null);
          return;
        }
        const parsed = normalizeWikiDocument(JSON.parse(result.content));
        if (cancelled || generation !== loadGenerationRef.current) return;
        if (!parsed) {
          setPhase("missing");
          setDoc(null);
          return;
        }
        setDoc(parsed);
        setPhase("ready");
      } catch {
        if (cancelled || generation !== loadGenerationRef.current) return;
        // 文件不存在 = 尚未生成（正常空态）。
        setPhase("missing");
        setDoc(null);
      }
    };
    void load();
    if (!active) {
      return () => {
        cancelled = true;
      };
    }
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, params.workspacePath, services, wikiJsonPath, refreshTick]);

  const catalog = useMemo(() => (doc ? buildWikiCatalogTree(doc) : []), [doc]);

  return {
    phase,
    homePath,
    workspaceHash: workspaceHash ?? undefined,
    wikiJsonPath: wikiJsonPath ?? undefined,
    doc,
    catalog,
    refresh,
  };
}

export function useRepoWikiSelection(catalog: WikiCatalogNode[]): {
  selectedPageId: string | null;
  selectPage: (pageId: string) => void;
} {
  const firstPageId = useMemo(() => {
    // 目录树含分组节点（page=null）：默认选中深度优先遇到的第一个页面节点。
    const findFirstPage = (nodes: WikiCatalogNode[]): string | null => {
      for (const node of nodes) {
        if (node.page) return node.page.id;
        const inChildren = findFirstPage(node.children);
        if (inChildren) return inChildren;
      }
      return null;
    };
    return findFirstPage(catalog);
  }, [catalog]);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  // 目录变化（首次生成/重新生成）时若当前选中页不存在则回落入口页。
  useEffect(() => {
    if (!selectedPageId) return;
    const exists = (nodes: WikiCatalogNode[]): boolean =>
      nodes.some((node) => node.page?.id === selectedPageId || exists(node.children));
    if (catalog.length > 0 && !exists(catalog)) {
      setSelectedPageId(firstPageId);
    }
  }, [catalog, firstPageId, selectedPageId]);
  const selectPage = useCallback((pageId: string) => setSelectedPageId(pageId), []);
  return {
    selectedPageId: selectedPageId ?? firstPageId,
    selectPage,
  };
}
