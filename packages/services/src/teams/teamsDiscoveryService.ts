// ============================================================
// Agent Teams - 只读发现服务实现（specs/agent-teams.md）
// ============================================================
//
// 读侧投影：扫描 <home>/.zcode/teams/<workspace-key>/ 下各团队目录的 config.json，
// 宽松归一为 TeamRoster。写事实源在 agent runtime（TeamCreate/TeamDelete/
// spawnTeammate），本服务绝不写盘。单个团队损坏（JSON 解析失败 / 字段形状不对）
// 跳过并 warn，不阻断其余团队——roster 展示允许部分可见，不允许一个坏文件拖垮整页。

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  TeamDashboardData,
  TeamInboxMessageProjection,
  TeamInboxParams,
  TeamInboxResult,
  TeamPlanProjection,
  TeamRoster,
  TeamRosterMember,
  TeamTaskProjection,
  TeamTasksResult,
  TeamsListResult,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { ITeamsService } from "./teams.ts";
import { resolveTeamsWorkspaceDir, type TeamsHomeDirResolver } from "./teamsPaths.js";

const logger = createServiceLogger("teams");

function scalarString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** 宽松归一成员；缺 name/agentId 等关键字段时丢弃该成员而不是整个团队。 */
function normalizeMember(raw: unknown): TeamRosterMember | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const name = scalarString(record.name);
  const agentId = scalarString(record.agentId);
  if (!name || !agentId) return undefined;
  return {
    name,
    agentId,
    isActive: record.isActive === true,
    ...(scalarString(record.color) === undefined
      ? {}
      : { color: scalarString(record.color) as TeamRosterMember["color"] }),
    ...(scalarString(record.permissionMode) === undefined
      ? {}
      : { permissionMode: scalarString(record.permissionMode) }),
    ...(scalarString(record.cwd) === undefined ? {} : { cwd: scalarString(record.cwd) }),
    ...(scalarString(record.sessionId) === undefined ? {} : { sessionId: scalarString(record.sessionId) }),
    ...(scalarString(record.joinedAt) === undefined ? {} : { joinedAt: scalarString(record.joinedAt) }),
  };
}

function normalizeTeam(teamName: string, raw: unknown): TeamRoster | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.members)) return undefined;
  const members = record.members
    .map(normalizeMember)
    .filter((member): member is TeamRosterMember => member !== undefined);
  return {
    name: scalarString(record.name) ?? teamName,
    ...(scalarString(record.description) === undefined ? {} : { description: scalarString(record.description) }),
    ...(scalarString(record.leadAgentId) === undefined ? {} : { leadAgentId: scalarString(record.leadAgentId) }),
    ...(scalarString(record.createdAt) === undefined ? {} : { createdAt: scalarString(record.createdAt) }),
    members,
  };
}

const TEAM_TASK_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;

/** 宽松归一任务;缺 taskId/subject/status 关键字段时丢弃该任务。 */
function normalizeTask(raw: unknown): TeamTaskProjection | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const taskId = scalarString(record.taskId);
  const subject = scalarString(record.subject);
  const status =
    typeof record.status === "string" && (TEAM_TASK_STATUSES as readonly string[]).includes(record.status)
      ? (record.status as TeamTaskProjection["status"])
      : undefined;
  if (!taskId || !subject || !status) return undefined;
  const owner = scalarString(record.owner);
  const externalId = scalarString(record.externalId);
  const blockedBy = Array.isArray(record.blockedBy)
    ? record.blockedBy.filter((item): item is string => typeof item === "string")
    : [];
  return {
    taskId,
    subject,
    status,
    version: typeof record.version === "number" && Number.isFinite(record.version) ? record.version : 0,
    ...(owner === undefined ? {} : { owner }),
    ...(blockedBy.length > 0 ? { blockedBy } : {}),
    ...(externalId === undefined ? {} : { externalId }),
    createdAt: scalarString(record.createdAt) ?? "",
    updatedAt: scalarString(record.updatedAt) ?? "",
  };
}

/** 宽松归一计划;缺 state/members/tasks 形状不符时整体省略。 */
function normalizePlan(raw: unknown): TeamPlanProjection | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const state = scalarString(record.state);
  if (!state || !Array.isArray(record.members) || !Array.isArray(record.tasks)) return undefined;
  const members: TeamPlanProjection["members"] = [];
  for (const item of record.members) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const name = scalarString(entry.name);
    if (!name) continue;
    const reason = scalarString(entry.reason);
    const difficulty = scalarString(entry.difficulty);
    members.push({
      name,
      prompt: scalarString(entry.prompt) ?? "",
      ...(reason === undefined ? {} : { reason }),
      ...(difficulty === undefined ? {} : { difficulty }),
    });
  }
  const tasks: TeamPlanProjection["tasks"] = [];
  for (const item of record.tasks) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const subject = scalarString(entry.subject);
    if (!subject) continue;
    const owner = scalarString(entry.owner);
    const depends = Array.isArray(entry.depends)
      ? entry.depends.filter((item): item is string => typeof item === "string")
      : [];
    tasks.push({ subject, ...(owner === undefined ? {} : { owner }), depends });
  }
  return { state, members, tasks };
}

export function createTeamsService(options?: {
  homeDirResolver?: TeamsHomeDirResolver;
}): ITeamsService {
  const homeDirResolver = options?.homeDirResolver;
  const service: ITeamsService = {
    async list(params): Promise<TeamsListResult> {
      const workspaceDir = resolveTeamsWorkspaceDir(params, homeDirResolver);
      let teamDirs: string[];
      try {
        teamDirs = await readdir(workspaceDir, { withFileTypes: true }).then((entries) =>
          entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
        );
      } catch {
        // 目录不存在 = 该 workspace 还没有过团队；这是常态而非错误。
        return { teams: [] };
      }

      const teams: TeamRoster[] = [];
      for (const teamName of teamDirs) {
        try {
          const raw = JSON.parse(await readFile(join(workspaceDir, teamName, "config.json"), "utf8"));
          const team = normalizeTeam(teamName, raw);
          if (team) teams.push(team);
        } catch (error) {
          logger?.warn("Skipping unreadable team config", {
            event: "agent-teams.discovery.config_unreadable",
            module: "services.teams",
            teamName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      teams.sort((a, b) => a.name.localeCompare(b.name));
      return { teams };
    },

    async listInboxMessages(params: TeamInboxParams): Promise<TeamInboxResult> {
      const workspaceDir = resolveTeamsWorkspaceDir(params, homeDirResolver);
      const inboxFile = join(workspaceDir, params.teamName, "inboxes", params.memberName + ".json");
      let raw: string;
      try {
        raw = await readFile(inboxFile, "utf8");
      } catch {
        // 收件箱不存在 = 该成员还没有收发过消息;常态而非错误。
        return { memberName: params.memberName, messages: [] };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        logger?.warn("Skipping unreadable team inbox", {
          event: "agent-teams.discovery.inbox_unreadable",
          module: "services.teams",
          teamName: params.teamName,
          memberName: params.memberName,
          error: error instanceof Error ? error.message : String(error),
        });
        return { memberName: params.memberName, messages: [] };
      }
      if (!Array.isArray(parsed)) {
        return { memberName: params.memberName, messages: [] };
      }
      const messages: TeamInboxMessageProjection[] = [];
      for (const item of parsed) {
        if (typeof item !== "object" || item === null) continue;
        const record = item as Record<string, unknown>;
        const id = scalarString(record.id);
        const from = scalarString(record.from);
        const to = scalarString(record.to);
        const sentAt = scalarString(record.sentAt);
        if (!id || !from || !to || !sentAt) continue;
        const payload = typeof record.payload === "object" && record.payload !== null
          ? (record.payload as Record<string, unknown>)
          : {};
        const payloadKind = typeof payload.kind === "string" ? payload.kind : "unknown";
        messages.push({
          id,
          from,
          to,
          ...(scalarString(record.summary) === undefined ? {} : { summary: scalarString(record.summary) }),
          ...(typeof payload.text === "string" ? { text: payload.text } : {}),
          payloadKind,
          ...(typeof payload.status === "string" ? { status: payload.status } : {}),
          sentAt,
          read: record.read === true,
        });
      }
      return { memberName: params.memberName, messages };
    },

    async listTasks(params): Promise<TeamTasksResult> {
      const workspaceDir = resolveTeamsWorkspaceDir(params, homeDirResolver);
      const tasksFile = join(workspaceDir, params.teamName, "tasks.json");
      let raw: string;
      try {
        raw = await readFile(tasksFile, "utf8");
      } catch {
        // tasks.json 不存在 = 该团队还没创建过共享任务;常态而非错误。
        return { tasks: [] };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        logger?.warn("Skipping unreadable team tasks", {
          event: "agent-teams.discovery.tasks_unreadable",
          module: "services.teams",
          teamName: params.teamName,
          error: error instanceof Error ? error.message : String(error),
        });
        return { tasks: [] };
      }
      // runtime 落盘为 { teamName, tasks: [...] };形状不符时整体跳过(与 list 同款取舍)。
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !Array.isArray((parsed as Record<string, unknown>).tasks)
      ) {
        return { tasks: [] };
      }
      const items = (parsed as Record<string, unknown>).tasks as unknown[];
      const tasks = items.map(normalizeTask).filter((task): task is TeamTaskProjection => task !== undefined);
      return { tasks };
    },

    async getDashboard(params): Promise<TeamDashboardData> {
      const workspaceDir = resolveTeamsWorkspaceDir(params, homeDirResolver);
      const { teams } = await service.list(params);
      // 团队刚被解散等场景下 roster 里找不到该团队:容忍,投影空名册继续聚合其余子集。
      const team =
        teams.find((candidate) => candidate.name === params.teamName) ?? { name: params.teamName, members: [] };
      const { tasks } = await service.listTasks(params);
      const inboxResults = await Promise.all(
        team.members.map((member) => service.listInboxMessages({ ...params, memberName: member.name })),
      );
      // 全队消息按 id 去重后按 sentAt 倒序(新→旧),供消息流面板直接消费。
      const merged = new Map<string, TeamInboxMessageProjection>();
      for (const result of inboxResults) {
        for (const message of result.messages) {
          merged.set(message.id, message);
        }
      }
      const messages = [...merged.values()].sort((a, b) => b.sentAt.localeCompare(a.sentAt));
      let plan: TeamPlanProjection | undefined;
      try {
        plan = normalizePlan(JSON.parse(await readFile(join(workspaceDir, params.teamName, "plan.json"), "utf8")));
      } catch {
        // plan.json 不存在/损坏 = 该团队没走过计划-审批流;面板不展示计划即可。
        plan = undefined;
      }
      return { team, tasks, messages, ...(plan === undefined ? {} : { plan }) };
    },
  };
  return service;
}
