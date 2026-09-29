// ============================================================
// Agent Teams - TeamCreate / TeamDelete tool contracts
// ============================================================
//
// 领域词汇见 specs/agent-teams.md：Lead（创建团队的会话）、Teammate（具名常驻代理）、
// TeamFile（团队注册表 JSON，磁盘事实源）。runtime 是唯一写入者；services/UI 只读。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const TEAM_CREATE_TOOL_NAME = "TeamCreate";
export const TEAM_DELETE_TOOL_NAME = "TeamDelete";

/**
 * 团队/成员名的共享约束：跨平台文件系统安全（Windows 保留名与非法字符在
 * team-paths.ts 的目录层另行拒绝），长度上限同时约束 mailbox 文件名。
 */
export const TEAM_NAME_MAX_CHARS = 64;
export const TEAM_MEMBER_NAME_MAX_CHARS = 64;
export const TEAM_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/;

export const TEAM_MAX_MEMBERS = 8;
/** TeamDelete 等待 teammate shutdown 审批的窗口；超时视为拒绝并强制终止。 */
export const TEAM_SHUTDOWN_APPROVAL_TIMEOUT_MS = 30_000;
/** lead 成员在 TeamFile.members 中的固定名（SendMessage from 与 roster 标识用）。 */
export const TEAM_LEAD_MEMBER_NAME = "team_lead";

export const teamNameSchema = z
  .string()
  .min(1)
  .max(TEAM_NAME_MAX_CHARS)
  .regex(TEAM_NAME_PATTERN, "Use letters, digits, spaces, '_' or '-'; must start alphanumeric");

export const teamMemberNameSchema = z
  .string()
  .min(1)
  .max(TEAM_MEMBER_NAME_MAX_CHARS)
  .regex(TEAM_NAME_PATTERN, "Use letters, digits, spaces, '_' or '-'; must start alphanumeric");

/** TeamFile 的成员记录；与磁盘 config.json 的字段一一对应。 */
export const TeamMemberSchema = z.object({
  agentId: z.string(),
  name: z.string(),
  color: z.string().optional(),
  permissionMode: z.string().optional(),
  cwd: z.string(),
  sessionId: z.string().optional(),
  isActive: z.boolean(),
  joinedAt: z.string(),
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;

export const TeamFileSchema = z.object({
  name: teamNameSchema,
  description: z.string().optional(),
  createdAt: z.string(),
  leadAgentId: z.string(),
  leadSessionId: z.string().optional(),
  members: z.array(TeamMemberSchema),
  /** v1 仅协议承载，spawn 时注入 teammate 权限上下文；编辑入口不做 UI。 */
  teamAllowedPaths: z
    .array(z.object({ path: z.string(), toolName: z.string() }))
    .optional(),
  /** v2.7：成员 spawn 即在独立 git worktree 副本工作（分支 zcode/<team>/<member>）。 */
  useWorktree: z.boolean().optional(),
});
export type TeamFile = z.infer<typeof TeamFileSchema>;

const TEAM_CREATE_OUTPUT_SCHEMA_BASE = {
  status: z.enum(["created", "existing"]),
  team: TeamFileSchema,
} as const;

export const TeamCreateInputSchema = z
  .object({
    name: teamNameSchema.describe("Unique team name within this workspace"),
    description: z.string().max(2_000).optional().describe("What this team is for"),
    /** v2.7：成员是否在独立 git worktree 副本工作（缺省共享工作区）。 */
    useWorktree: z.boolean().optional(),
    /** v2.8：团队角色模板名（<workspaceRoot>/.zcode/team-templates/<name>.md）。 */
    template: z.string().max(64).optional(),
  })
  .strict();
export type TeamCreateInput = z.infer<typeof TeamCreateInputSchema>;

export const TeamCreateOutputSchema = z
  .object({ ...TEAM_CREATE_OUTPUT_SCHEMA_BASE, templatePlan: z.array(z.string()).optional() })
  .strict();
export type TeamCreateOutput = z.infer<typeof TeamCreateOutputSchema>;

export const TeamCreateInputJsonSchema = toToolJsonSchema(TeamCreateInputSchema);
export const TeamCreateOutputJsonSchema = toToolJsonSchema(TeamCreateOutputSchema);

export const TeamDeleteInputSchema = z
  .object({
    name: teamNameSchema.describe("Name of the team to disband"),
  })
  .strict();
export type TeamDeleteInput = z.infer<typeof TeamDeleteInputSchema>;

export const TeamDeleteOutputSchema = z
  .object({
    status: z.enum(["deleted", "not_found"]),
    /** 收到 shutdown 请求的成员数；v1 无 teammate 时为 0。 */
    shutdownRequested: z.number().int().nonnegative(),
    message: z.string().optional(),
  })
  .strict();
export type TeamDeleteOutput = z.infer<typeof TeamDeleteOutputSchema>;

export const TeamDeleteInputJsonSchema = toToolJsonSchema(TeamDeleteInputSchema);
export const TeamDeleteOutputJsonSchema = toToolJsonSchema(TeamDeleteOutputSchema);
