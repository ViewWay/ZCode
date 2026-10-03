// ============================================================
// Agent Teams - TeamPlan 团队计划-审批-启动契约(v2.10,对齐 cc-haha v0.6.7 TeamPlanTool)
// ============================================================
//
// TeamCreate 之后、Agent spawn 之前,lead 用 TeamPlan 提交完整团队草案
// (成员 + 任务 + 依赖),submit 后进入 review_pending 等待用户批准;
// 用户批准(approve)后按批准快照实例化。lead 被制度性禁止绕过审批
// (approve 走权限确认面)。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const TEAM_PLAN_TOOL_NAME = "TeamPlan";
export const TEAM_PLAN_APPROVE_TOOL_NAME = "TeamPlanApprove";

export const TEAM_PLAN_MEMBER_NAME_MAX_CHARS = 64;
export const TEAM_PLAN_PROMPT_MAX_CHARS = 8_000;
export const TEAM_PLAN_TASK_SUBJECT_MAX_CHARS = 200;

export const teamPlanMemberSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  agentType: z.string().max(64).optional(),
  prompt: z.string().min(1).max(8_000),
  /** 成员模型路由：approve 后经 launchPlan 回灌，lead 以 Agent 的 model 参数透传到 spawn。 */
  model: z.string().max(128).optional(),
  /** 为什么设这个成员(可解释性)。 */
  reason: z.string().max(500).optional(),
  difficulty: z.enum(["low", "medium", "high"]).optional(),
});
export type TeamPlanMember = z.infer<typeof teamPlanMemberSchema>;

export const teamPlanTaskSchema = z.object({
  id: z.string().min(1).max(128),
  subject: z.string().min(1).max(200),
  /** owner 引用 member.name。 */
  owner: z.string().max(64).optional(),
  /** 依赖引用任务 subject(计划内自然语言键);校验存在性。 */
  depends: z.array(z.string().min(1).max(200)).max(16).optional(),
});
export type TeamPlanTask = z.infer<typeof teamPlanTaskSchema>;

export const TeamPlanRecordSchema = z.object({
  schemaVersion: z.literal(1),
  teamName: z.string().min(1),
  sessionId: z.string().min(1),
  /** 从 1 起,每次成功写 +1;replace/submit/approve 需 expected_revision CAS。 */
  revision: z.number().int().positive(),
  /** draft → review_pending → approved;cancelled 为终态。 */
  state: z.enum(["draft", "review_pending", "approved", "cancelled"]),
  members: z.array(teamPlanMemberSchema).min(1).max(8),
  tasks: z.array(teamPlanTaskSchema).max(32),
  feedback: z.string().max(2_000).optional(),
  approvedAt: z.string().optional(),
});
export type TeamPlanRecord = z.infer<typeof TeamPlanRecordSchema>;
export type TeamPlanState = TeamPlanRecord["state"];

export const TeamPlanInputSchema = z
  .object({
    team_name: z.string().min(1).max(64),
    operation: z.enum(["get", "replace", "submit", "approve"]),
    /** replace/submit/approve 必填(get 可选);CAS 防并发。 */
    expected_revision: z.number().int().positive().optional(),
    /** replace 的完整计划。 */
    plan: z
      .object({
        members: z.array(teamPlanMemberSchema).min(1).max(8),
        tasks: z.array(teamPlanTaskSchema).max(32),
      })
      .strict()
      .optional(),
    /** 驳回意见(reject 语义并入 replace 的反馈循环)。 */
    feedback: z.string().max(2_000).optional(),
  })
  .strict();
export type TeamPlanInput = z.infer<typeof TeamPlanInputSchema>;

export const TeamPlanOutputSchema = z
  .object({
    status: z.enum(["ok", "error"]),
    error: z.string().optional(),
    errorCode: z.string().optional(),
    plan: TeamPlanRecordSchema.optional(),
    /** approve 成功时回灌 lead 的实例化剧本(成员 spawn 计划 + 任务创建计划)。 */
    launchPlan: z.array(z.string()).optional(),
  })
  .strict();
export type TeamPlanOutput = z.infer<typeof TeamPlanOutputSchema>;

export const TeamPlanInputJsonSchema = toToolJsonSchema(TeamPlanInputSchema);
export const TeamPlanOutputJsonSchema = toToolJsonSchema(TeamPlanOutputSchema);