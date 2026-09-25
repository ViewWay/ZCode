import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRepoWikiGeneratePrompt,
  buildWikiCatalogTree,
  computeWorkspaceWikiHash,
  getRepoWikiDirPath,
  getRepoWikiJsonPath,
  normalizeWikiDocument,
  REPO_WIKI_PAGE_FAILED_MARKER,
  REPO_WIKI_PAGE_PENDING_MARKER,
  summarizeWikiGeneration,
} from "../src/lib/repoWiki.js";

const HOME = "/home/user";
// 12 位 hash 与官方版目录命名一致（sha256(绝对路径) 前 12 hex）。
const HASH = "0123456789ab";
const WIKI_JSON = `${HOME}/.zcode/v2/repo-wiki/${HASH}/wiki.json`;

test("getRepoWikiDirPath/JsonPath follow the documented storage layout", () => {
  assert.equal(getRepoWikiDirPath(HOME, HASH), `${HOME}/.zcode/v2/repo-wiki/${HASH}`);
  assert.equal(getRepoWikiJsonPath(HOME, HASH), WIKI_JSON);
});

test("computeWorkspaceWikiHash returns the official 12-hex sha256 prefix, stable and path-sensitive", async () => {
  const hash = await computeWorkspaceWikiHash("/home/user/project");
  assert.match(hash, /^[0-9a-f]{12}$/);
  assert.equal(hash, await computeWorkspaceWikiHash("/home/user/project"));
  assert.notEqual(hash, await computeWorkspaceWikiHash("/home/user/project2"));
  // 尾部斜杠不影响身份
  assert.equal(hash, await computeWorkspaceWikiHash("/home/user/project/"));
});

test("normalizeWikiDocument keeps valid pages and the official page fields", () => {
  const doc = normalizeWikiDocument({
    workspacePath: "/repo",
    language: "zh-CN",
    updatedAt: 123,
    pages: [
      {
        id: "page-1-aaaaaaaa",
        title: "总览",
        markdown: "# 总览",
        order: 1,
        description: "一句话简介",
        filePaths: ["README.md", "src/main.ts"],
        updatedAt: 120,
      },
      { id: "bad" },
      "not-an-object",
      {
        id: "page-2-bbbbbbbb",
        title: "调度",
        parentId: "page-1-aaaaaaaa",
        markdown: "# 调度",
        sources: [{ path: "/src/a.ts", startLine: 1, endLine: 9 }, { nope: true }],
      },
    ],
  });
  assert.ok(doc);
  assert.equal(doc.pages.length, 2);
  assert.equal(doc.pages[0].description, "一句话简介");
  assert.deepEqual(doc.pages[0].filePaths, ["README.md", "src/main.ts"]);
  assert.equal(doc.pages[1].parentId, "page-1-aaaaaaaa");
  assert.equal(doc.pages[1].sources?.length, 1);
  assert.equal(doc.pages[1].sources?.[0].path, "/src/a.ts");
  assert.equal(doc.workspacePath, "/repo");
});

test("normalizeWikiDocument falls back for envelope fields and returns null with no usable pages", () => {
  // 信封 updatedAt 缺省回落页面 updatedAt 最大值；language 缺省 zh-CN。
  const doc = normalizeWikiDocument({
    pages: [
      { id: "a", title: "A", markdown: "x", updatedAt: 42 },
      { id: "b", title: "B", markdown: "y", updatedAt: 7 },
    ],
  });
  assert.ok(doc);
  assert.equal(doc.updatedAt, 42);
  assert.equal(doc.language, "zh-CN");
  assert.equal(doc.catalogTree, undefined);

  assert.equal(normalizeWikiDocument({ pages: [] }), null);
  assert.equal(normalizeWikiDocument("nope"), null);
});

test("buildWikiCatalogTree prefers catalogTree with group nodes and appends unreferenced pages", () => {
  const doc = normalizeWikiDocument({
    catalogTree: [
      {
        id: "g1",
        title: "分组A",
        children: [
          { id: "n1", title: "总览", pageId: "p1" },
          { id: "n2", title: "调度", pageId: "p2" },
          { id: "n3", title: "悬空引用", pageId: "missing" },
        ],
      },
    ],
    pages: [
      { id: "p2", title: "调度", markdown: "m2", order: 2 },
      { id: "p1", title: "总览", markdown: "m1", order: 1 },
      { id: "p3", title: "孤儿页", markdown: "m3", order: 3 },
    ],
  });
  const tree = buildWikiCatalogTree(doc);
  assert.equal(tree.length, 2);
  // 分组节点：无 page，子节点按 order 排序，悬空 pageId 被丢弃。
  assert.equal(tree[0].page, null);
  assert.equal(tree[0].children.length, 2);
  assert.equal(tree[0].children[0].page?.id, "p1");
  assert.equal(tree[0].children[1].page?.id, "p2");
  // 未被树引用的页面兜底挂在根部。
  assert.equal(tree[1].page?.id, "p3");
});

test("buildWikiCatalogTree derives from parentId when catalogTree is missing", () => {
  const doc = normalizeWikiDocument({
    pages: [
      { id: "b", title: "B", markdown: "m-b", order: 1 },
      { id: "root", title: "Root", markdown: "m-root", order: 0 },
      { id: "b-child", title: "Child", parentId: "b", markdown: "m-child", order: 2 },
    ],
  });
  const tree = buildWikiCatalogTree(doc);
  assert.equal(tree.length, 2);
  assert.equal(tree[0].page?.id, "root");
  assert.equal(tree[1].page?.id, "b");
  assert.equal(tree[1].children[0].page?.id, "b-child");
});

test("buildRepoWikiGeneratePrompt targets the documented wiki path with official-depth requirements", () => {
  const workspacePath = "/home/user/project";
  const zh = buildRepoWikiGeneratePrompt(
    {
      homePath: HOME,
      workspaceHash: HASH,
      workspacePath,
      language: "zh-CN",
      generateDiagrams: true,
      retryPerPage: 0,
    },
    "project",
  );
  // 写入目标必须落在文档约定的 wiki.json 路径，Agent 才能被 UI 轮询观测到
  assert.ok(zh.includes(WIKI_JSON));
  assert.ok(zh.includes(workspacePath));
  assert.ok(zh.includes("（project）"));
  assert.ok(zh.includes("简体中文"));
  // 官方深度契约：主题深潜页规模、进度标记、行级 sources、增量落盘、信封 schema
  assert.ok(zh.includes("10–30 个"));
  assert.ok(zh.includes(`「${REPO_WIKI_PAGE_PENDING_MARKER}」`));
  assert.ok(zh.includes("sources"));
  assert.ok(zh.includes("catalogTree"));
  assert.ok(zh.includes("workspacePath"));

  const en = buildRepoWikiGeneratePrompt(
    {
      homePath: HOME,
      workspaceHash: HASH,
      workspacePath,
      language: "en-US",
      generateDiagrams: true,
      retryPerPage: 0,
    },
    "project",
  );
  assert.ok(en.includes(WIKI_JSON));
  assert.ok(en.includes("English"));
  assert.ok(!en.includes("简体中文"));
});

test("buildRepoWikiGeneratePrompt honors the generateDiagrams toggle", () => {
  const base = {
    homePath: HOME,
    workspaceHash: HASH,
    workspacePath: "/home/user/project",
    language: "zh-CN" as const,
  };
  const withDiagrams = buildRepoWikiGeneratePrompt({ ...base, generateDiagrams: true, retryPerPage: 0 }, "project");
  const withoutDiagrams = buildRepoWikiGeneratePrompt({ ...base, generateDiagrams: false, retryPerPage: 0 }, "project");
  // 文档措辞：只在确有帮助处生成图表；关闭时全部用文字表达
  assert.ok(withDiagrams.includes("确有帮助"));
  assert.ok(withoutDiagrams.includes("不要插入"));
  assert.ok(withoutDiagrams.includes(WIKI_JSON));
  assert.ok(withoutDiagrams.includes("10–30 个"));
});

test("buildRepoWikiGeneratePrompt carries the per-page retry count", () => {
  const prompt = buildRepoWikiGeneratePrompt(
    {
      homePath: HOME,
      workspaceHash: HASH,
      workspacePath: "/home/user/project",
      language: "zh-CN",
      generateDiagrams: true,
      retryPerPage: 3,
    },
    "project",
  );
  // 第四生成选项：单页失败自动重试次数；失败页写精确失败标记
  assert.ok(prompt.includes("重试最多 3 次"));
  assert.ok(prompt.includes(`「${REPO_WIKI_PAGE_FAILED_MARKER}」`));
});

test("summarizeWikiGeneration derives progress from the exact page markers", () => {
  const doc = normalizeWikiDocument({
    pages: [
      { id: "p1", title: "一", markdown: "正文一", order: 1 },
      { id: "p2", title: "二", markdown: REPO_WIKI_PAGE_PENDING_MARKER, order: 2 },
      { id: "p3", title: "三", markdown: REPO_WIKI_PAGE_PENDING_MARKER, order: 3 },
      { id: "p4", title: "四", markdown: REPO_WIKI_PAGE_FAILED_MARKER, order: 4 },
    ],
  });
  const progress = summarizeWikiGeneration(doc);
  assert.ok(progress);
  assert.equal(progress.total, 4);
  assert.equal(progress.done, 1);
  assert.equal(progress.failed, 1);
  // 「正在生成」= 目录序第一个未完成页（失败页不算进行中）
  assert.equal(progress.generatingPageId, "p2");
  assert.deepEqual(progress.waitingPageIds, ["p3", "p4"]);

  // 全部完成 / 空文档 → 非生成中
  const done = normalizeWikiDocument({
    pages: [{ id: "p1", title: "一", markdown: "正文", order: 1 }],
  });
  assert.equal(summarizeWikiGeneration(done), null);
  assert.equal(summarizeWikiGeneration(null), null);
});
