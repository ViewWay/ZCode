import { joinFilePath } from "@/lib/path.js";

/**
 * Repo Wiki（对齐官方 zcode wiki 格式，历史样本验证于 ~/.zcode/v2/repo-wiki/）：
 * - 存储：`~/.zcode/v2/repo-wiki/<workspace-hash>/wiki.json`，本地、绝不写入仓库。
 * - workspace-hash = sha256(绝对 workspacePath) 前 12 位 hex，与官方一致；
 *   官方版已生成的 wiki 因此可被本 UI 直接阅读。
 * - `wiki.json` 为纯 JSON：主题深潜页（每页含 mermaid 图与行级源码引用）+ 分组目录树。
 * - 生成由后台任务按本文件 schema 渐进写入；UI 轮询读取，目录先出现即可开始阅读。
 */

export const REPO_WIKI_DIR_SEGMENTS = [".zcode", "v2", "repo-wiki"] as const;

export function getRepoWikiDirPath(homePath: string, workspaceHash: string): string {
  return joinFilePath(homePath, [...REPO_WIKI_DIR_SEGMENTS, workspaceHash].join("/"));
}

export function getRepoWikiJsonPath(homePath: string, workspaceHash: string): string {
  return joinFilePath(getRepoWikiDirPath(homePath, workspaceHash), "wiki.json");
}

/** workspace-hash：绝对 workspacePath 的 SHA-256 前 12 位十六进制（与官方版一致）。 */
export async function computeWorkspaceWikiHash(workspacePath: string): Promise<string> {
  const normalized = workspacePath.replace(/\/+$/, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest))
    .slice(0, 6)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export interface WikiPageSource {
  path: string;
  startLine?: number;
  endLine?: number;
}

/**
 * 生成进度标记：Agent 按提示词契约把未完成页写为精确串（UI 据此推导进度），
 * 完成后以真实正文覆盖；失败页写 FAILED 标记，计入失败数。
 */
export const REPO_WIKI_PAGE_PENDING_MARKER = "生成中";
export const REPO_WIKI_PAGE_FAILED_MARKER = "生成失败";

export interface WikiPage {
  /** 页面稳定 id；目录树的节点键。 */
  id: string;
  title: string;
  /** 父页面 id；顶层页面缺省/为 null。 */
  parentId?: string | null;
  /** 同层排序键，小者在前。 */
  order?: number;
  /** 一句话页面简介（官方页面字段）。 */
  description?: string;
  /** 该页覆盖的主要文件（仓库相对路径）。 */
  filePaths?: string[];
  markdown: string;
  /** 每条论断的源码出处（文件路径 + 可选行区间），UI 渲染为可点击链接。 */
  sources?: WikiPageSource[];
  updatedAt?: number;
}

/** 信封里的原始目录树节点：分组节点无 pageId，页面节点以 pageId 引用 pages。 */
export interface WikiCatalogTreeNode {
  id: string;
  title: string;
  order?: number;
  pageId?: string;
  children?: WikiCatalogTreeNode[];
}

export interface WikiDocument {
  workspacePath?: string;
  workspaceKey?: string;
  language: "zh-CN" | "en-US";
  generationModel?: string;
  /** 最后更新时间（epoch ms）；缺省取页面 updatedAt 最大值。 */
  updatedAt: number;
  pages: WikiPage[];
  catalogTree?: WikiCatalogTreeNode[];
}

/** 渲染用目录节点：分组节点 page 为 null（不可点开，仅作分组标题）。 */
export interface WikiCatalogNode {
  id: string;
  title: string;
  page: WikiPage | null;
  children: WikiCatalogNode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** 宽松归一 wiki.json：结构不对的页跳过而不是抛错，坏文件不至于让面板白屏。 */
export function normalizeWikiDocument(raw: unknown): WikiDocument | null {
  if (!isRecord(raw)) return null;
  const rawPages = Array.isArray(raw.pages) ? raw.pages : [];
  const pages: WikiPage[] = [];
  for (const entry of rawPages) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id : "";
    const markdown = typeof entry.markdown === "string" ? entry.markdown : "";
    const title = typeof entry.title === "string" && entry.title ? entry.title : id;
    if (!id || !markdown) continue;
    const parentId = typeof entry.parentId === "string" ? entry.parentId : null;
    const order = typeof entry.order === "number" ? entry.order : Number.MAX_SAFE_INTEGER;
    const description = optionalString(entry.description);
    const filePaths = Array.isArray(entry.filePaths)
      ? entry.filePaths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : [];
    const sources = Array.isArray(entry.sources)
      ? entry.sources.filter(
          (source): source is WikiPageSource => isRecord(source) && typeof source.path === "string",
        )
      : [];
    const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : undefined;
    pages.push({
      id,
      title,
      markdown,
      parentId,
      order,
      ...(description ? { description } : {}),
      ...(filePaths.length > 0 ? { filePaths } : {}),
      sources,
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    });
  }
  if (pages.length === 0) return null;

  const language = raw.language === "en-US" ? "en-US" : "zh-CN";
  const docUpdatedAt =
    typeof raw.updatedAt === "number"
      ? raw.updatedAt
      : Math.max(0, ...pages.map((page) => page.updatedAt ?? 0));
  const catalogTree = normalizeCatalogTree(raw.catalogTree);

  return {
    ...(optionalString(raw.workspacePath) ? { workspacePath: optionalString(raw.workspacePath) } : {}),
    ...(optionalString(raw.workspaceKey) ? { workspaceKey: optionalString(raw.workspaceKey) } : {}),
    language,
    ...(optionalString(raw.generationModel)
      ? { generationModel: optionalString(raw.generationModel) }
      : {}),
    updatedAt: docUpdatedAt,
    pages,
    ...(catalogTree ? { catalogTree } : {}),
  };
}

function normalizeCatalogTree(raw: unknown, depth = 0): WikiCatalogTreeNode[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || depth > 8) return undefined;
  const nodes: WikiCatalogTreeNode[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id : "";
    const title = typeof entry.title === "string" ? entry.title : "";
    if (!id || !title) continue;
    const node: WikiCatalogTreeNode = { id, title };
    if (typeof entry.order === "number") node.order = entry.order;
    if (typeof entry.pageId === "string" && entry.pageId) node.pageId = entry.pageId;
    const children = normalizeCatalogTree(entry.children, depth + 1);
    if (children) node.children = children;
    nodes.push(node);
  }
  return nodes.length > 0 ? nodes : undefined;
}

const compareNodes = (a: WikiCatalogNode, b: WikiCatalogNode): number => {
  const orderA = a.page?.order ?? a.children[0]?.page?.order ?? Number.MAX_SAFE_INTEGER;
  const orderB = b.page?.order ?? b.children[0]?.page?.order ?? Number.MAX_SAFE_INTEGER;
  if (orderA !== orderB) return orderA - orderB;
  return a.title.localeCompare(b.title);
};

const sortCatalogNodes = (nodes: WikiCatalogNode[]): void => {
  nodes.sort(compareNodes);
  for (const node of nodes) sortCatalogNodes(node.children);
};

/**
 * 组装渲染目录树：优先信封 catalogTree（含纯分组节点），并兜底追加未被树引用的页面；
 * 缺失时按 parentId 派生。分组节点（page=null）不可选中，仅作分组标题。
 */
export function buildWikiCatalogTree(doc: WikiDocument): WikiCatalogNode[] {
  const pageById = new Map(doc.pages.map((page) => [page.id, page]));
  const referenced = new Set<string>();
  const nodes: WikiCatalogNode[] = [];

  const fromTree = (node: WikiCatalogTreeNode): WikiCatalogNode | null => {
    const children = (node.children ?? [])
      .map(fromTree)
      .filter((child): child is WikiCatalogNode => child !== null);
    const page = node.pageId ? (pageById.get(node.pageId) ?? null) : null;
    if (page) referenced.add(page.id);
    if (!page && children.length === 0) return null;
    return { id: node.id, title: node.title, page, children };
  };

  for (const node of doc.catalogTree ?? []) {
    const built = fromTree(node);
    if (built) nodes.push(built);
  }

  // 兜底：树里没挂到的页面（或完全没有 catalogTree）按 parentId/平铺补在根部。
  for (const page of doc.pages) {
    if (referenced.has(page.id)) continue;
    const parent = page.parentId ?? null;
    const parentNode = parent ? pageById.get(parent) : undefined;
    if (parentNode && parentNode.id !== page.id && !referenced.has(parentNode.id)) {
      // 父页面本身也不在树里：连同父页面一起补挂，避免页面丢失。
      referenced.add(parentNode.id);
      nodes.push({ id: parentNode.id, title: parentNode.title, page: parentNode, children: [] });
    }
    if (parent && parentNode && referenced.has(parentNode.id)) {
      const group = nodes.find((node) => node.page?.id === parentNode.id);
      if (group) {
        referenced.add(page.id);
        group.children.push({ id: page.id, title: page.title, page, children: [] });
        continue;
      }
    }
    referenced.add(page.id);
    nodes.push({ id: page.id, title: page.title, page, children: [] });
  }

  sortCatalogNodes(nodes);
  return nodes;
}

export interface RepoWikiGenerateArgs {
  homePath: string;
  workspaceHash: string;
  workspacePath: string;
  language: "zh-CN" | "en-US";
  /** 生成图表开关：关闭时全部用文字表达（等价官方 generateDiagrams=false）。 */
  generateDiagrams: boolean;
  /** 单页失败自动重试次数（官方第四选项，默认 0）。 */
  retryPerPage: number;
}

/**
 * 生成提示词（深度对齐官方版 wiki：主题深潜页 + 按需 mermaid 图 + 行级源码出处）：
 * 指示 Agent 把 wiki.json 写到文档约定路径，目录先落盘、页面渐进补齐。
 */
export function buildRepoWikiGeneratePrompt(args: RepoWikiGenerateArgs, repoNameHint: string): string {
  const wikiPath = getRepoWikiJsonPath(args.homePath, args.workspaceHash);
  const repoName = repoNameHint;
  const languageWord = args.language === "zh-CN" ? "简体中文" : "English";
  const diagramRule = args.generateDiagrams
    ? "7. 只在图表确有帮助且有源码依据处生成 mermaid 图（架构图、流程图、时序图、状态图），无必要则不加。"
    : "7. 不要插入 mermaid 图，全部用文字与列表表达。";
  return [
    `请为工作区 ${args.workspacePath}（${repoName}）生成一份 Repo Wiki：一份子系统级的深度架构指南，页面语言使用${languageWord}。`,
    `把结果写入 ${wikiPath}（JSON，UTF-8），严格遵守以下约定：`,
    "",
    "一、结构规划",
    "1. 先通读仓库（目录布局、README、构建/依赖配置、入口与主执行链路），识别核心子系统、关键数据结构与执行路径。",
    "2. 规划 10–30 个「主题深潜页」（小型仓库可为 5–10 页）：按子系统/模块/机制切分，每页聚焦一个能独立讲透的主题；不要写安装、CI/CD、贡献指南这类通用产品文档页。",
    "3. 用 4–8 个分组节点把页面组织成目录树（分组节点无 pageId，页面节点以 pageId 引用页面 id）。",
    "",
    "二、落盘方式（增量，务必遵守）",
    `4. 第一步先写目录骨架：完整 catalogTree + pages 数组（每页填 id/title/parentId/order/description/filePaths，markdown 一律先填精确占位串「${REPO_WIKI_PAGE_PENDING_MARKER}」，不要用其他写法），尽快落盘——阅读端目录一出现就开始展示。`,
    `5. 之后逐页补全 markdown 并即时落盘；每写完一批页面就刷新顶层 updatedAt 与对应页面的 updatedAt。单页生成失败时自动重试最多 ${args.retryPerPage} 次；重试耗尽仍失败的页面，markdown 写精确串「${REPO_WIKI_PAGE_FAILED_MARKER}」，然后继续其余页面，不要中止任务。`,
    "",
    "三、单页要求（每一页都要满足）",
    "6. markdown 目标 3000–8000 字：开头 2–3 段总览 →「模块概览/关键文件」清单 → 分小节深挖核心数据结构、执行链路、状态机与边界条件。",
    diagramRule,
    "8. 关键论断在正文用「仓库相对路径/文件#L行号」风格标注出处；该页 sources 数组同步列出 { path, startLine, endLine }，供阅读端跳转。",
    "9. 每页填 description（一句话简介）与 filePaths（该页覆盖的主要文件，仓库相对路径）。",
    "",
    "四、schema 与事实性",
    `10. 信封：{ workspacePath: "${args.workspacePath}", workspaceKey, language: "${args.language}", catalogTree, pages, createdAt, updatedAt }（epoch 毫秒时间戳）。`,
    '11. 页面：{ id: "page-<序号>-<8位十六进制>", parentId, title, order, description, filePaths, markdown, sources, createdAt, updatedAt }；顶层页面 parentId 为 null。',
    "12. 内容必须以当前工作区源码为准，不编造不存在的文件、接口或行为；源码中读不到的机制要明确说明，不得臆测。",
  ].join("\n");
}

export interface WikiGenerationProgress {
  /** 目录规划的总页数。 */
  total: number;
  /** 已完成（正文非占位/失败标记）的页数。 */
  done: number;
  /** 失败（FAILED 标记）页数。 */
  failed: number;
  /** 目录序第一个未完成页：UI 显示为「正在生成」。 */
  generatingPageId: string | null;
  /** 其余未完成页 id：目录显示「等待生成」。 */
  waitingPageIds: string[];
}

function isPendingPageMarkdown(markdown: string): boolean {
  const trimmed = markdown.trim();
  return (
    trimmed === REPO_WIKI_PAGE_PENDING_MARKER ||
    trimmed === `${REPO_WIKI_PAGE_PENDING_MARKER}…` ||
    trimmed === REPO_WIKI_PAGE_FAILED_MARKER
  );
}

/**
 * 从磁盘 wiki.json 推导生成进度（纯函数）：done = 正文已就绪的页数，
 * generating = 目录序第一个未完成页。全部完成时返回 null（非生成中）。
 */
export function summarizeWikiGeneration(doc: WikiDocument | null): WikiGenerationProgress | null {
  if (!doc || doc.pages.length === 0) return null;
  const byOrder = [...doc.pages].sort(
    (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER),
  );
  const pending = byOrder.filter((page) => isPendingPageMarkdown(page.markdown));
  if (pending.length === 0) return null;
  const failed = pending.filter((page) => page.markdown.trim() === REPO_WIKI_PAGE_FAILED_MARKER);
  // 「正在生成」取目录序第一个非失败未完成页；失败页只计入失败数。
  const generatingPage = pending.find(
    (page) => page.markdown.trim() !== REPO_WIKI_PAGE_FAILED_MARKER,
  );
  const waitingPageIds = pending
    .filter((page) => page.id !== generatingPage?.id)
    .map((page) => page.id);
  return {
    total: doc.pages.length,
    done: doc.pages.length - pending.length,
    failed: failed.length,
    generatingPageId: generatingPage?.id ?? null,
    waitingPageIds,
  };
}
