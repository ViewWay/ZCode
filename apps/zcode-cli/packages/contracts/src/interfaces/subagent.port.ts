// ============================================================
// Subagent Port - child agent execution boundary
// ============================================================

import type { AgentBackgroundedOutput, AgentOutput } from "../tools/agent.js";
import type { TeammateLaunchedOutput } from "../tools/teammate-spawn.js";
import type { Model, ModelSelection } from "../model/index.js";
import type { ModelRequestDependencies } from "../model/invocation-context.js";
import type { SessionId, ToolCallId, TurnId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

export interface SubagentRunRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  parentToolCallId: ToolCallId | string;
  agentType: string;
  description: string;
  prompt: string;
  callerCanReadOutputFile?: boolean;
  workingDirectory: string;
  workspaceRoot: string;
  trace: TraceContext;
  /**
   * Agent Teams（specs/agent-teams.md AC4）：仅 teammate 生成路径携带。随请求穿线到
   * 交互请求 origin，UI 据此显示「队友 · 团队」来源徽标；普通 subagent 不携带。
   */
  teamName?: string;
  teammateName?: string;
  /**
   * Agent Teams v2：teammate 生成路径携带的 workspace 身份（AGENTS.md Workspace Identity）。
   * 随请求穿线到 child runtime 配置，teammate 与 lead 用同一身份键解析团队目录；
   * 普通 subagent 不携带，按路径 fallback 解析，行为不变。
   */
  workspaceIdentity?: string;
  /**
   * 成员模型路由（Agent Teams）：仅 teammate 生成路径携带。lead 经 Agent 工具
   * model 入参点名的成员模型标签（"providerId/modelId"），随请求穿线到 child
   * selection 解析（优先于 profile 静态配置）；普通 subagent 不携带，行为不变。
   */
  model?: string;
}

export interface SubagentRunOptions {
  signal?: AbortSignal;
  /** 未显式选模的 child 从父 Agent Loop 继承的不可变 Model。 */
  model?: Model;
  /** Core Server 对前台 child 的最高优先级 Selection；每个 child 仍自行创建 Model。 */
  modelOverride?: {
    selection: ModelSelection;
    requestDependencies?: ModelRequestDependencies;
    background: "deny";
  };
}

export interface SubagentLaunchRequest extends SubagentRunRequest {
  runInBackground?: boolean;
}

export type SubagentLaunchOptions = SubagentRunOptions;

export type SubagentStartRequest = SubagentRunRequest;

/** teammate 生成请求：在 start 语义之上追加团队关停与 workspace 归一事实。 */
export interface SubagentTeammateSpawnRequest extends SubagentStartRequest {
  teamName: string;
  teammateName: string;
  /** Workspace Identity（AGENTS.md）：团队目录按身份键隔离，不按裸路径。 */
  workspaceIdentity?: string;
  /** 家目录解析注入点；生产缺省取 agent 进程的 os.homedir()。 */
  homeDirResolver?: () => string;
}

/** TeamDelete 请求：解散团队（specs/agent-teams.md AC5 完整语义）。 */
export interface SubagentTeamShutdownRequest {
  teamName: string;
  /** 团队目录定位事实（AGENTS.md Workspace Identity：身份键隔离）。 */
  workspaceIdentity?: string;
  workspaceRoot: string;
  workingDirectory: string;
  /** 家目录解析注入点；生产缺省取 agent 进程的 os.homedir()。 */
  homeDirResolver?: () => string;
}

/** TeamDelete 结果：requested = 收到 shutdown_request 的成员数（lead 除外）。 */
export interface SubagentTeamShutdownResult {
  status: "deleted" | "not_found";
  requested: number;
  /** 等待窗口内自愿退出的成员数；其余按 spec 30s 超时强制终止。 */
  exited: number;
}

export interface SubagentStartOptions {
  signal?: AbortSignal;
  /** 后台 child 启动时继承的普通 Model；临时 turn 模型仍禁止进入后台。 */
  model?: Model;
}

export interface SubagentWaitOptions {
  signal?: AbortSignal;
}

export interface SubagentStopOptions {
  signal?: AbortSignal;
}

export interface SubagentSendMessageRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  parentToolCallId: ToolCallId | string;
  to: string;
  summary: string;
  message: string;
  workingDirectory: string;
  workspaceRoot: string;
  trace: TraceContext;
}

export interface SubagentSendMessageOptions {
  signal?: AbortSignal;
}

export type SubagentSendMessageDelivery = "queued" | "steered" | "resumed_background" | "teammate_mailbox";

export interface SubagentSendMessageResult {
  status: "success" | "failed";
  messageId: string;
  delivery?: SubagentSendMessageDelivery;
  message?: string;
  error?: string;
  agentId?: string;
  taskId?: string;
  outputFile?: string;
  /** 命中队友邮箱路由时的收件成员名；广播为成员列表。 */
  teammate?: string;
  broadcastTo?: string[];
  broadcastFailures?: { member: string; error: string }[];
}

export type SubagentTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "killed"
  | "stopped"
  | "lost";

export interface SubagentTaskSnapshot {
  taskId: string;
  agentId: string;
  agentType: string;
  description: string;
  status: SubagentTaskStatus;
  startedAt: Date;
  completedAt?: Date;
  childSessionId?: SessionId;
  parentToolCallId?: ToolCallId | string;
  pid?: number;
  error?: string;
  output?: AgentOutput;
  outputFile?: string;
  notified?: boolean;
}

export interface SubagentPort {
  launch(request: SubagentLaunchRequest, options?: SubagentLaunchOptions): Promise<AgentOutput>;
  run(request: SubagentRunRequest, options?: SubagentRunOptions): Promise<AgentOutput>;
  start?(
    request: SubagentStartRequest,
    options?: SubagentStartOptions,
  ): Promise<AgentBackgroundedOutput>;
  /**
   * Agent Teams：生成具名常驻 teammate（specs/agent-teams.md）。
   * 与 start 的差异：首个 turn 完成后不终态化，teammate 空闲待命轮询团队邮箱，
   * 收到消息即恢复新一轮；仅随 shutdown / TeamDelete / 会话终止而退出。
   */
  spawnTeammate?(
    request: SubagentTeammateSpawnRequest,
    options?: SubagentStartOptions,
  ): Promise<TeammateLaunchedOutput>;
  /**
   * Agent Teams（AC5 完整语义）：向全部存活 teammate 投递 shutdown_request，
   * 等待成员收敛（上限 30s）后强制终止残留者并删除团队目录。
   * 端口未实现（无 teammate 运行时）时调用方回退为「仅删目录」。
   */
  shutdownTeam?(
    request: SubagentTeamShutdownRequest,
    options?: SubagentStopOptions,
  ): Promise<SubagentTeamShutdownResult>;
  backgroundTask?(taskId: string): Promise<SubagentTaskSnapshot | undefined>;
  getTask?(taskId: string): Promise<SubagentTaskSnapshot | undefined>;
  waitForTask?(
    taskId: string,
    options?: SubagentWaitOptions,
  ): Promise<SubagentTaskSnapshot | undefined>;
  stopTask?(
    taskId: string,
    options?: SubagentStopOptions,
  ): Promise<SubagentTaskSnapshot | undefined>;
  sendMessage?(
    request: SubagentSendMessageRequest,
    options?: SubagentSendMessageOptions,
  ): Promise<SubagentSendMessageResult>;
}
