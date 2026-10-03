import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import {
  buildWikiCatalogTree,
  computeWorkspaceWikiHash,
  flattenWikiCatalogPageIds,
  getRepoWikiJsonPath,
  normalizeWikiDocument,
  type WikiCatalogNode,
  type WikiDocument,
} from "./model.js";
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
  /** wiki.json 存在但读取/解析失败（二进制/截断/坏 JSON）：空态需提示覆盖风险，不能伪装成未生成。 */
  invalid: boolean;
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
  const { homePath, workspaceHash, wikiJsonPath, doc, catalog, phase, invalid, refresh } =
    useRepoWikiWorkspaceInner(services, params);
  return { phase, invalid, homePath, workspaceHash, wikiJsonPath, doc, catalog, refresh };
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
  const [invalid, setInvalid] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const loadGenerationRef = useRef(0);
  // 轮询去重（spec v5）：记录上次成功读到的原文，内容一致时跳过解析与 setState——
  // 磁盘仍是唯一事实源，去重只避免每 2.5s 的全量 JSON.parse 与派生重算/重渲染。
  const lastContentRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setWorkspaceHash(null);
    setDoc(null);
    setPhase("resolving");
    setInvalid(false);
    lastContentRef.current = null;
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
          setInvalid(false);
          lastContentRef.current = null;
          return;
        }
        const result = await services.fileService.readTextFile({
          path: wikiJsonPath,
          offset: 0,
          length: 4 * 1024 * 1024,
        });
        if (cancelled || generation !== loadGenerationRef.current) return;
        if (result.isBinary || result.truncated || !result.content) {
          // 文件在但读不出可用内容：标记 invalid，让空态提示覆盖风险（spec v4）。
          setPhase("missing");
          setDoc(null);
          setInvalid(true);
          return;
        }
        // 内容与上次一致：状态已是该内容的产物，跳过解析与 setState。
        if (result.content === lastContentRef.current) {
          return;
        }
        const parsed = normalizeWikiDocument(JSON.parse(result.content));
        if (cancelled || generation !== loadGenerationRef.current) return;
        if (!parsed) {
          setPhase("missing");
          setDoc(null);
          setInvalid(true);
          lastContentRef.current = result.content;
          return;
        }
        lastContentRef.current = result.content;
        setDoc(parsed);
        setPhase("ready");
        setInvalid(false);
      } catch {
        if (cancelled || generation !== loadGenerationRef.current) return;
        // 抛错多为文件被并发删除（正常空态）；invalid 只在「确认存在但读坏」时置位，
        // 这里无法区分，回落为不存在语义，等下一次存在性检查纠正。
        setPhase("missing");
        setDoc(null);
        lastContentRef.current = null;
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
    invalid,
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
  // 目录树含分组节点（page=null）：默认选中深度优先遇到的第一个页面节点
  // （v7 复用 flattenWikiCatalogPageIds，避免与导航序各写一套递归）。
  const firstPageId = useMemo(() => flattenWikiCatalogPageIds(catalog)[0] ?? null, [catalog]);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  // 目录变化（首次生成/重新生成）时若当前选中页不存在则回落入口页。
  useEffect(() => {
    if (!selectedPageId) return;
    const existsInCatalog = flattenWikiCatalogPageIds(catalog).includes(selectedPageId);
    if (catalog.length > 0 && !existsInCatalog) {
      setSelectedPageId(firstPageId);
    }
  }, [catalog, firstPageId, selectedPageId]);
  const selectPage = useCallback((pageId: string) => setSelectedPageId(pageId), []);
  return {
    selectedPageId: selectedPageId ?? firstPageId,
    selectPage,
  };
}
