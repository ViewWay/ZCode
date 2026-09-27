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
import type { TeamRoster, TeamRosterMember, TeamsListResult } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { ITeamsService } from "./teams.js";
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
    ...(scalarString(record.sessionId) === undefined
      ? {}
      : { sessionId: scalarString(record.sessionId) }),
    ...(scalarString(record.joinedAt) === undefined
      ? {}
      : { joinedAt: scalarString(record.joinedAt) }),
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
    ...(scalarString(record.description) === undefined
      ? {}
      : { description: scalarString(record.description) }),
    ...(scalarString(record.leadAgentId) === undefined
      ? {}
      : { leadAgentId: scalarString(record.leadAgentId) }),
    ...(scalarString(record.createdAt) === undefined
      ? {}
      : { createdAt: scalarString(record.createdAt) }),
    members,
  };
}

export function createTeamsService(options?: {
  homeDirResolver?: TeamsHomeDirResolver;
}): ITeamsService {
  const homeDirResolver = options?.homeDirResolver;
  return {
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
  };
}
