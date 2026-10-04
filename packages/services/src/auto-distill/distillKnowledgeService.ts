import { ServiceChannels, type DistillCandidate } from "@zcode/shared";
import {
  atomicWritePrivateTextFile,
  createDistillCandidateStore,
  resolveProjectMemoryRoot,
  type DistillCandidateStore,
} from "@zcode/shared/node";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, readdir, rename } from "node:fs/promises";

import { getZCodeDataRootDir } from "../paths.js";
import { createServiceDescriptor } from "../descriptors.js";
import { aggregateModelUsageStats } from "../zcode-agent/modelTrajectory.js";

// 已沉淀知识审阅服务（specs/auto-distill.md）。
// renderer 经 ProxyChannel 直连（automationRecording 同款范式）；候选存储与项目记忆
// 落盘都属 Desktop 本地 Host 域（~/.zcode/distill + ~/.zcode/cli/memories），远端 Host
// 不提供时 UI 隐藏该区。
//
// "确认 → 写入 memory"的桥（spec：复用既有 memory 子系统读写路径，不建第二写入路径）：
// - core 侧 memory agent 是 turn 内模型驱动提取（runtime 自调度，宿主没有触发 RPC 面），
//   候选确认是确定性内容的落盘，无法也不应拉起模型循环。
// - 因此确认动作直接写 core memory agent 同一项目记忆目录（resolveProjectMemoryRoot
//   同源公式，@zcode/shared/node 唯一实现），产出 recall 可读的条目文件（frontmatter
//   description + metadata.node_type/originSessionId，与 stampMemoryOriginSessionId 的
//   格式约定一致）；原子写复用 @zcode/shared/node 的私有文件原子写。
// - 候选文件仍由 @zcode/shared/node 的 store 唯一读写；本服务不持久化任何第二份状态。

export interface DistillConfirmOutcome {
  /** confirmed=恰好写入一条记忆；missing=候选已不存在（重复确认不产生第二次写）。 */
  status: "confirmed" | "missing";
  /** 确认后落盘的项目记忆条目文件（status=confirmed 时给出，供 UI 提示）。 */
  memoryFilePath?: string;
}

/** 效果基线（dgm archive 理念）：确认时刻的轨迹统计快照，供后续 delta 对比。 */
export interface MemoryEffectBaseline {
  sampledAt: string;
  toolErrors: number;
  calls: number;
  sessions: number;
  tokens: number;
}

export interface MemoryEffectDelta {
  sessions: number;
  toolErrorsDelta: number;
  tokensDelta: number;
  measuredAt: string;
}

export interface ConfirmedMemoryEffect {
  file: string;
  summary: string;
  originSessionId?: string;
  baseline: MemoryEffectBaseline;
  delta: MemoryEffectDelta | null;
}

/** 效果基线采样：确认时刻的轨迹统计（同数据源，公平对比）。 */
async function sampleEffectBaseline(): Promise<MemoryEffectBaseline> {
  const stats = await aggregateModelUsageStats({ maxSessions: 500 });
  return {
    sampledAt: new Date().toISOString(),
    toolErrors: stats.erroredRecords,
    calls: stats.scannedRecords,
    sessions: stats.scannedSessions,
    tokens: stats.totalInputTokens + stats.totalOutputTokens,
  };
}

/** 从记忆 Markdown 解析 frontmatter 的最小解析（description + metadata JSON 行）。 */
function parseFrontmatterField(text: string, key: string): string | undefined {
  const match = text.match(new RegExp(`^  ${key}: (.+)$`, "m"));
  return match?.[1];
}

/**
 * 从已确认记忆文件解析效果基线（frontmatter metadata.effect.baseline JSON 行）。
 * 无基线（旧条目/非 autodistill 文件）返回 undefined。
 */
function parseEffectBaseline(text: string): MemoryEffectBaseline | undefined {
  const line = text.match(/^  effect:\s*$/m);
  if (!line) return undefined;
  const baselineLine = text.match(/^    baseline: (.+)$/m);
  if (!baselineLine) return undefined;
  try {
    const raw = JSON.parse(baselineLine[1] ?? "null") as unknown;
    if (typeof raw !== "object" || raw === null) return undefined;
    const record = raw as Record<string, unknown>;
    if (
      typeof record.sampledAt !== "string" ||
      typeof record.toolErrors !== "number" ||
      typeof record.calls !== "number" ||
      typeof record.sessions !== "number" ||
      typeof record.tokens !== "number"
    ) {
      return undefined;
    }
    return record as unknown as MemoryEffectBaseline;
  } catch {
    return undefined;
  }
}

export interface IDistillKnowledgeService {
  /** 审阅列表：按置信度降序、同分按创建时间升序（store.list 语义）。 */
  list(): Promise<DistillCandidate[]>;
  /**
   * 确认候选：写入来源工作区的项目记忆（幂等——候选移交恰好一次，文件名确定性），
   * 并从候选文件删除。候选不存在返回 status=missing。
   */
  confirm(candidateId: string): Promise<DistillConfirmOutcome>;
  /** 删除候选：不产生任何 memory 写入。 */
  delete(candidateId: string): Promise<boolean>;
  /**
   * 提升为技能草稿：在用户技能根目录生成 SKILL.md（不启用）；候选不存在返回 undefined。
   */
  promote(candidateId: string): Promise<{ skillFilePath: string } | undefined>;
  /** 已确认记忆的效果视图（delta 惰性计算）：按改善幅度排序供审阅列表展示。 */
  listConfirmedWithEffect(): Promise<ConfirmedMemoryEffect[]>;
  /** 归档已确认记忆（低效果淘汰）：从各工作区 memoryRoot 移入 archive/ 子目录。 */
  archiveConfirmed(file: string): Promise<boolean>;
}

export const IDistillKnowledgeService = createServiceDescriptor<IDistillKnowledgeService>(
  ServiceChannels.DistillKnowledge,
);

export interface DistillKnowledgeServiceDeps {
  /** 候选存储注入（fake store 单测用）；缺省用户级 ~/.zcode/distill。 */
  store?: DistillCandidateStore;
  /** cliStorageRoot 注入（测试用）；缺省 <dataRoot>/cli，与 services memoryService 的记忆根一致。 */
  cliStorageRoot?: string;
  /** 用户技能根目录注入（测试用）；缺省 ~/.zcode/skills（对齐 skillsService getUserZcodeSkillRoot）。 */
  skillsRootDir?: string;
  /** 进度日志；复用 host 进程 logger。 */
  logger?: Pick<Console, "info" | "warn">;
}

/** 用户级 ZCode 技能根目录（对齐 packages/services/src/skills/skillsService.ts 的同名实现）。 */
function resolveDefaultUserSkillsRootDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  const home = envHome && envHome.length > 0 ? envHome : homedir();
  return join(home, ".zcode", "skills");
}

export function createDistillKnowledgeService(
  deps: DistillKnowledgeServiceDeps = {},
): IDistillKnowledgeService {
  const store = deps.store ?? createDistillCandidateStore();
  const cliStorageRoot = deps.cliStorageRoot ?? join(getZCodeDataRootDir(), "cli");
  const skillsRootDir = deps.skillsRootDir ?? resolveDefaultUserSkillsRootDir();
  const log = deps.logger;

  return {
    async list(): Promise<DistillCandidate[]> {
      return store.list();
    },

    async confirm(candidateId: string): Promise<DistillConfirmOutcome> {
      // confirm 原子移交：拿不到数据说明已确认/删除，直接幂等返回，不产生第二次写。
      const candidate = await store.confirm(candidateId);
      if (!candidate) return { status: "missing" };
      if (!candidate.workspace) {
        // 早期候选缺工作区信息：无法定位项目记忆目录。补偿回候选文件（所有权未移交），
        // 让用户删除重建，而不是静默丢弃或写错目录。
        await store.add([candidate]);
        throw new Error("候选缺少来源工作区信息，无法定位项目记忆目录");
      }

      const memoryRoot = resolveProjectMemoryRoot({
        cliStorageRoot,
        workspaceIdentity: candidate.workspace.identity,
        workspacePath: candidate.workspace.path,
      });
      const memoryFilePath = join(memoryRoot, `${candidate.id}.md`);
      try {
        // 确认时刻采样效果基线（dgm archive 理念：确认→度量→留优），写入记忆 frontmatter；
        // 采样失败不阻塞确认（基线缺失只影响效果展示，不影响记忆本体）。
        const baseline = await sampleEffectBaseline().catch(() => undefined);
        await atomicWritePrivateTextFile(
          memoryFilePath,
          buildDistillMemoryFile(candidate, baseline),
        );
      } catch (error) {
        // 写失败则候选回到待审列表（数据所有权尚未移交），下次确认重走同一幂等路径。
        await store.add([candidate]);
        throw error;
      }
      log?.info(`[distill-knowledge] confirmed candidate=${candidate.id} memory=${memoryFilePath}`);
      return { status: "confirmed", memoryFilePath };
    },

    async delete(candidateId: string): Promise<boolean> {
      return store.delete(candidateId);
    },

    async promote(candidateId: string): Promise<{ skillFilePath: string } | undefined> {
      const promoted = await store.promote(candidateId, { skillsRootDir });
      if (!promoted) return undefined;
      log?.info(
        `[distill-knowledge] promoted candidate=${candidateId} skill=${promoted.skillFilePath}`,
      );
      return { skillFilePath: promoted.skillFilePath };
    },

    /**
     * 已确认记忆的效果视图（delta 惰性计算）：扫描各工作区 memoryRoot 中带
     * autodistill 标记的条目，对有 baseline 的取当前轨迹统计对比。
     * 无 baseline 的旧条目跳过（效果排序不适用）。
     */
    async listConfirmedWithEffect(): Promise<ConfirmedMemoryEffect[]> {
      const projectsRoot = join(cliStorageRoot, "memories", "projects");
      const current = await sampleEffectBaseline();
      const out: ConfirmedMemoryEffect[] = [];
      let workspaces: string[] = [];
      try {
        workspaces = (await readdir(projectsRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return out;
      }
      for (const workspace of workspaces) {
        const dir = join(projectsRoot, workspace);
        let files: string[] = [];
        try {
          files = (await readdir(dir)).filter((name) => name.endsWith(".md"));
        } catch {
          continue;
        }
        for (const file of files) {
          const text = await readFile(join(dir, file), "utf8").catch(() => "");
          const baseline = parseEffectBaseline(text);
          if (!baseline) continue;
          const delta: MemoryEffectDelta = {
            sessions: current.sessions - baseline.sessions,
            toolErrorsDelta: current.toolErrors - baseline.toolErrors,
            tokensDelta: current.tokens - baseline.tokens,
            measuredAt: new Date().toISOString(),
          };
          const summary = parseFrontmatterField(text, "description") ?? file;
          const originSessionId = parseFrontmatterField(text, "originSessionId");
          out.push({
            file,
            summary: summary.replace(/^["']|["']$/g, ""),
            ...(originSessionId ? { originSessionId } : {}),
            baseline,
            delta,
          });
        }
      }
      // 改善最大（toolErrorsDelta 最小/最负）在前。
      return out.sort((a, b) => {
        const da = a.delta?.toolErrorsDelta ?? Number.MAX_SAFE_INTEGER;
        const db = b.delta?.toolErrorsDelta ?? Number.MAX_SAFE_INTEGER;
        return da - db;
      });
    },

    /**
     * 归档已确认记忆（MemOS 分层理念：低效果条目退入 archive 子目录，退出召回但
     * 保留档案）。file 为 basename；扫描各工作区 memoryRoot 定位后移动。
     */
    async archiveConfirmed(file: string): Promise<boolean> {
      const projectsRoot = join(cliStorageRoot, "memories", "projects");
      let workspaces: string[] = [];
      try {
        workspaces = (await readdir(projectsRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return false;
      }
      for (const workspace of workspaces) {
        const source = join(projectsRoot, workspace, file);
        let text: string;
        try {
          text = await readFile(source, "utf8");
        } catch {
          continue;
        }
        const archiveDir = join(projectsRoot, workspace, "archive");
        await mkdir(archiveDir, { recursive: true });
        await rename(source, join(archiveDir, file));
        log?.info(`[distill-knowledge] archived memory=${file} workspace=${workspace}`);
        return true;
      }
      return false;
    },
  };
}

/**
 * 沉淀确认后的记忆条目内容。frontmatter 与 core memory 子系统约定一致：
 * description 供 recall manifest 预览；metadata.node_type/originSessionId 与
 * stampMemoryOriginSessionId 的写入口径相同；type=project 归入项目知识召回类别。
 */
function buildDistillMemoryFile(
  candidate: DistillCandidate,
  baseline?: MemoryEffectBaseline,
): string {
  const frontmatter = [
    "description: " + yamlDoubleQuoted(candidate.summary),
    "metadata:",
    "  node_type: memory",
    "  type: project",
    `  originSessionId: ${candidate.sourceSessionId}`,
    "  autodistill: true",
    ...(baseline ? ["  effect:", `    baseline: ${JSON.stringify(baseline)}`] : []),
  ].join("\n");
  const body = [
    `# ${candidate.summary}`,
    "",
    "## 来源",
    `- 会话：${candidate.sourceSessionId}`,
    `- 类别：${candidate.kind}`,
    `- 置信度：${candidate.confidence}`,
    `- 沉淀时间：${candidate.createdAt}`,
    "",
    "（由「已沉淀知识」审阅确认自动生成，可按需补充执行细节。）",
  ].join("\n");
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

/** YAML 双引号标量：JSON 字符串即合法 YAML（与 candidateStore 的 frontmatter 写法同源）。 */
function yamlDoubleQuoted(value: string): string {
  return JSON.stringify(value);
}
