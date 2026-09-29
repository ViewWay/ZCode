// ============================================================
// Agent Teams - 团队知识库存储（<team-dir>/knowledge/<slug>.md）
// ============================================================
//
// specs/agent-teams.md P2（v2.3）：「学会并共享新技能」的最小闭环——
// 成员把可复用做法沉淀为 SKILL.md 式文档（frontmatter：when_to_use/author/
// updated_at + 正文），检索用关键词子串匹配（Voyager-lite，不引 embedding）。
// 写入所有权归 runtime；TeamDelete 归档行为见 team-shutdown.ts（后续批次）。

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isSafeTeamPathSegment, type TeamWorkspaceDirs } from "./team-paths.js";

export interface TeamKnowledgeDeps {
  dirs: TeamWorkspaceDirs;
}

export interface TeamKnowledgeEntry {
  slug: string;
  whenToUse: string;
  author: string;
  updatedAt: string;
  fileName: string;
}

export interface TeamKnowledgeSearchHit {
  slug: string;
  whenToUse: string;
  author: string;
  snippet: string;
}

export interface WriteTeamKnowledgeInput {
  slug: string;
  whenToUse: string;
  content: string;
  author: string;
}

const KNOWLEDGE_DIR_NAME = "knowledge";
const KNOWLEDGE_FILE_MAX_ENTRIES = 200;
const KNOWLEDGE_SLUG_MAX_CHARS = 64;

function knowledgeDir(deps: TeamKnowledgeDeps, teamName: string): string {
  return join(deps.dirs.teamDir(teamName), KNOWLEDGE_DIR_NAME);
}

function knowledgeFile(deps: TeamKnowledgeDeps, teamName: string, slug: string): string {
  return join(knowledgeDir(deps, teamName), slug + ".md");
}

/** 简易 frontmatter 解析（行式 key: value）；解析失败按空记录处理，不抛错。 */
function parseFrontmatter(raw: string): { whenToUse: string; author: string; updatedAt: string } {
  const result = { whenToUse: "", author: "", updatedAt: "" };
  if (!raw.startsWith("---")) return result;
  const end = raw.indexOf("\n---", 3);
  const head = end === -1 ? raw.slice(3) : raw.slice(3, end);
  for (const line of head.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key === "when_to_use") result.whenToUse = value;
    else if (key === "author") result.author = value;
    else if (key === "updated_at") result.updatedAt = value;
  }
  return result;
}

function bodyOf(raw: string): string {
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw;
  const bodyStart = raw.indexOf("\n", end + 1);
  return bodyStart === -1 ? "" : raw.slice(bodyStart + 1);
}

/** 写入（覆盖语义）：知识文档允许迭代更新，updated_at 每次刷新。 */
export async function writeTeamKnowledge(
  deps: TeamKnowledgeDeps,
  teamName: string,
  input: WriteTeamKnowledgeInput,
): Promise<{ slug: string; fileName: string; updated: boolean }> {
  if (!isSafeTeamPathSegment(input.slug, KNOWLEDGE_SLUG_MAX_CHARS)) {
    throw new Error("Invalid knowledge slug: " + input.slug);
  }
  const dir = knowledgeDir(deps, teamName);
  const file = knowledgeFile(deps, teamName, input.slug);
  let updated = false;
  try {
    await readFile(file, "utf8");
    updated = true;
  } catch {
    updated = false;
  }
  const now = new Date().toISOString();
  const content = input.content.endsWith("\n") ? input.content : input.content + "\n";
  const doc = ["---", "when_to_use: " + input.whenToUse.replace(/\n/g, " "), "author: " + input.author, "updated_at: " + now, "---", content].join("\n");
  await mkdir(dir, { recursive: true });
  await writeFile(file, doc, "utf8");
  return { slug: input.slug, fileName: input.slug + ".md", updated };
}

/** 列出团队知识条目（轻量元数据）；目录不存在视为空。 */
export async function listTeamKnowledge(
  deps: TeamKnowledgeDeps,
  teamName: string,
): Promise<TeamKnowledgeEntry[]> {
  const dir = knowledgeDir(deps, teamName);
  let fileNames: string[];
  try {
    fileNames = await readdir(dir);
  } catch {
    return [];
  }
  const entries: TeamKnowledgeEntry[] = [];
  for (const fileName of fileNames.filter((name) => name.endsWith(".md")).sort()) {
    if (entries.length >= KNOWLEDGE_FILE_MAX_ENTRIES) break;
    const raw = await readFile(join(dir, fileName), "utf8");
    const meta = parseFrontmatter(raw);
    entries.push({ slug: fileName.slice(0, -3), whenToUse: meta.whenToUse, author: meta.author, updatedAt: meta.updatedAt, fileName });
  }
  return entries;
}

/** 关键词检索：when_to_use + 正文大小写不敏感子串匹配；返回带命中行片段的结果。 */
export async function searchTeamKnowledge(
  deps: TeamKnowledgeDeps,
  teamName: string,
  input: { query: string; limit?: number },
): Promise<TeamKnowledgeSearchHit[]> {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) return [];
  const limit = input.limit ?? 5;
  const hits: TeamKnowledgeSearchHit[] = [];
  for (const entry of await listTeamKnowledge(deps, teamName)) {
    if (hits.length >= limit) break;
    const raw = await readFile(join(knowledgeDir(deps, teamName), entry.fileName), "utf8");
    const haystack = (entry.whenToUse + "\n" + bodyOf(raw)).toLowerCase();
    const at = haystack.indexOf(query);
    if (at === -1) continue;
    const lineStart = haystack.lastIndexOf("\n", at) + 1;
    const lineEnd = haystack.indexOf("\n", at);
    const snippet = haystack.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim().slice(0, 300);
    hits.push({ slug: entry.slug, whenToUse: entry.whenToUse, author: entry.author, snippet });
  }
  return hits;
}

/**
 * 技能提升(v2.8):把团队知识文档改写为标准 SKILL.md,写入用户级技能目录
 * (<homedir>/.zcode/skills/<skillName>/SKILL.md)——跨项目可被 Skill 工具加载
 * (当前会话不注册,下个会话生效)。覆盖语义,updated 标志与知识写入一致。
 */
export async function promoteTeamKnowledge(
  deps: TeamKnowledgeDeps,
  teamName: string,
  slug: string,
  options?: { skillsRoot?: string; skillName?: string },
): Promise<{ skillName: string; path: string; updated: boolean }> {
  const skillName = options?.skillName ?? slug;
  if (!isSafeTeamPathSegment(skillName, 64)) {
    throw new Error("Invalid skill name: " + skillName);
  }
  const file = knowledgeFile(deps, teamName, slug);
  const raw = await readFile(file, "utf8");
  const meta = parseFrontmatter(raw);
  const body = bodyOf(raw);
  const skillsRoot = options?.skillsRoot ?? join(homedir(), ".zcode", "skills");
  const skillDir = join(skillsRoot, skillName);
  const skillFile = join(skillDir, "SKILL.md");
  let updated = false;
  try {
    await readFile(skillFile, "utf8");
    updated = true;
  } catch {
    updated = false;
  }
  const doc = [
    "---",
    "name: " + skillName,
    "description: " + (meta.whenToUse.length > 0 ? meta.whenToUse : "Promoted from team knowledge " + slug),
    "---",
    body.endsWith("\n") ? body : body + "\n",
  ].join("\n");
  await mkdir(skillDir, { recursive: true });
  await writeFile(skillFile, doc, "utf8");
  return { skillName, path: skillFile, updated };
}

/**
 * 知识归档(P2 收尾,specs/agent-teams.md v2.5):TeamDelete/会话清理时把 knowledge/
 * 移入 <teamsRoot>/_archive/<teamName>-<timestamp>/knowledge——团队解散,知识不散。
 * 返回归档路径;团队没有知识文档时返回 undefined。
 */
export async function archiveTeamKnowledge(
  deps: TeamKnowledgeDeps,
  teamName: string,
): Promise<string | undefined> {
  const source = knowledgeDir(deps, teamName);
  let fileNames: string[];
  try {
    fileNames = await readdir(source);
  } catch {
    return undefined;
  }
  if (fileNames.length === 0) return undefined;
  const target = join(deps.dirs.teamsRoot, "_archive", teamName + "-" + Date.now().toString(36), "knowledge");
  await mkdir(target, { recursive: true });
  for (const fileName of fileNames) {
    await rename(join(source, fileName), join(target, fileName));
  }
  return target;
}
