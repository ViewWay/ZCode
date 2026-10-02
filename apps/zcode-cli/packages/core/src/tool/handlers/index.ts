// ============================================================
// Built-in Tool Handlers
// ============================================================

import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  LIST_MODELS_TOOL_NAME,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
  SUBMIT_RESULT_TOOL_NAME,
  type JsonSchema,
} from "@zcode/contracts";
import type { ToolEntry } from "../types.js";
import type { AgentProfile } from "../../subagent/profile.js";
import { readToolEntry } from "./read.js";
import { writeToolEntry } from "./write.js";
import { editToolEntry } from "./edit.js";
import { bashToolEntry, createBashToolEntry } from "./bash.js";
import type { BashTimeoutPolicy } from "../bash-timeout-policy.js";
import { createJsToolEntry, jsToolEntry } from "./node-repl.js";
import { globToolEntry } from "./glob.js";
import { grepToolEntry } from "./grep.js";
import { webFetchToolEntry } from "./webfetch.js";
import { webSearchToolEntry } from "./websearch.js";
import {
  agentToolEntry,
  createAgentToolEntry,
  createTaskToolEntry,
  taskToolEntry,
} from "./agent.js";
import { isSubagentDispatchToolName } from "../compat.js";
import { skillToolEntry } from "./skill.js";
import { todoReadToolEntry, todoWriteToolEntry } from "./todo.js";
import {
  cronCreateToolEntry,
  cronDeleteToolEntry,
  cronListToolEntry,
  cronUpdateToolEntry,
} from "./cron.js";
import { offPeakCreateToolEntry, offPeakListToolEntry } from "./off-peak.js";
import {
  createEnterPlanModeToolEntry,
  enterPlanModeToolEntry,
  exitPlanModeToolEntry,
} from "./plan-mode.js";
import { askUserQuestionToolEntry } from "./ask-user-question.js";
import { sendMessageToolEntry } from "./send-message.js";
import { respondToCoordinatorToolEntry } from "./respond-to-coordinator.js";
import { teamCreateToolEntry } from "./team-create.js";
import { teamDeleteToolEntry } from "./team-delete.js";
import {
  taskCreateToolEntry,
  taskGetToolEntry,
  taskListToolEntry,
  taskUpdateToolEntry,
} from "./team-task.js";
import {
  teamKnowledgePromoteToolEntry,
  teamKnowledgeSearchToolEntry,
  teamKnowledgeWriteToolEntry,
} from "./team-knowledge.js";
import {
  sessionCreateToolEntry,
  sessionListToolEntry,
  sessionTalkToolEntry,
} from "./session-chat.js";
import { createSubmitResultToolEntry, submitResultToolEntry } from "./submit-result.js";
import { escalateToolEntry } from "./escalate.js";
import { resolveWorkflowQuestionToolEntry } from "./resolve-workflow-question.js";
import { taskOutputToolEntry } from "./task-output.js";
import { taskStopToolEntry } from "./task-stop.js";
import { readSessionContextToolEntry } from "./read-session-context.js";
// 外部会话只读互操作（specs/external-sessions.md）：always-on 只读工具，端口无关。
import { listExternalSessionsToolEntry } from "./external-session-list.js";
import { readExternalSessionToolEntry } from "./external-session-read.js";
// agent 可调桌面设置（specs/agent-settings.md）：端口在场才注册（fail-closed）。
import { getDesktopSettingToolEntry } from "./get-desktop-setting.js";
import { setDesktopSettingToolEntry } from "./set-desktop-setting.js";
import {
  GET_DESKTOP_SETTING_TOOL_NAME,
  SET_DESKTOP_SETTING_TOOL_NAME,
} from "@zcode/contracts";
// 图像工具（specs/image-tools.md）：端口在场才注册（fail-closed）。
import { imageGenToolEntry } from "./image-gen.js";
import { imageEditToolEntry } from "./image-edit.js";
// 语音工具（specs/voice-pipeline.md）：端口在场才注册（fail-closed）。
import { asrTranscribeToolEntry } from "./asr-transcribe.js";
import { ttsSpeechToolEntry } from "./tts-speech.js";
// PDF 预览联动（specs/pdf-preview-linkage.md）：桌面形态门待 UI 链路接入，当前休眠。
import { pdfLocateToolEntry } from "./pdf-locate.js";
import { IMAGE_GEN_TOOL_NAME, IMAGE_EDIT_TOOL_NAME } from "@zcode/contracts";
import {
  ASR_TRANSCRIBE_TOOL_NAME,
  TTS_SPEECH_TOOL_NAME,
} from "@zcode/contracts";
import { PDF_LOCATE_TOOL_NAME } from "@zcode/contracts";
import { amendWorkflowToolEntry } from "./amend-workflow.js";
import { createWorkflowToolEntry } from "./create-workflow.js";
import { saveWorkflowToolEntry } from "./save-workflow.js";
import { listSavedWorkflowsToolEntry } from "./list-saved-workflows.js";
import { listModelsToolEntry } from "./list-models.js";
import { evalWorkflowSnippetToolEntry } from "./eval-workflow-snippet.js";
import { listWorkflowRunsToolEntry } from "./list-workflow-runs.js";
import { getWorkflowRunToolEntry } from "./get-workflow-run.js";
import { resumeWorkflowRunToolEntry } from "./resume-workflow-run.js";
// import { workflowToolEntry } from "./workflow.js";
import { createToolRuleNameSet } from "../tool-visibility.js";

// direct 分支保留 Glob/Grep 工具实现；embedded search 分支由 registerBuiltInTools
// 统一隐藏 Glob/Grep，并通过 Bash find/grep 接管搜索。

export const builtInTools: ToolEntry[] = [
  readToolEntry,
  writeToolEntry,
  editToolEntry,
  // applyPatchToolEntry,
  bashToolEntry,
  globToolEntry,
  grepToolEntry,
  webFetchToolEntry,
  webSearchToolEntry,
  todoReadToolEntry,
  todoWriteToolEntry,
  cronCreateToolEntry,
  cronListToolEntry,
  cronUpdateToolEntry,
  cronDeleteToolEntry,
  offPeakCreateToolEntry,
  offPeakListToolEntry,
  enterPlanModeToolEntry,
  exitPlanModeToolEntry,
  askUserQuestionToolEntry,
  sendMessageToolEntry,
  respondToCoordinatorToolEntry,
  // Agent Teams（specs/agent-teams.md）：团队注册表与共享任务列表工具面。
  // 注册门在 registerBuiltInTools 的 includeTeam / includeTeamTasks。
  teamCreateToolEntry,
  teamDeleteToolEntry,
  taskCreateToolEntry,
  taskUpdateToolEntry,
  taskGetToolEntry,
  taskListToolEntry,
  teamKnowledgeWriteToolEntry,
  teamKnowledgeSearchToolEntry,
  teamKnowledgePromoteToolEntry,
  // TeamPlan（v2.10）：计划-审批-启动。TeamPlanApprove 走 needsApproval 人类权限面。
  // 会话互聊（实验，默认关闭）：端口在场（宿主开关开启）才注册。
  sessionListToolEntry,
  sessionTalkToolEntry,
  sessionCreateToolEntry,
  // agent 可调桌面设置（specs/agent-settings.md）：端口在场才注册（fail-closed）。
  getDesktopSettingToolEntry,
  setDesktopSettingToolEntry,
  // 图像工具（specs/image-tools.md）：端口在场才注册（fail-closed）。
  imageGenToolEntry,
  imageEditToolEntry,
  // 语音工具（specs/voice-pipeline.md）：端口在场才注册（fail-closed）。
  asrTranscribeToolEntry,
  ttsSpeechToolEntry,
  // PDF 预览联动（specs/pdf-preview-linkage.md）：桌面形态门待 UI 链路，当前休眠不注册。
  pdfLocateToolEntry,
  submitResultToolEntry,
  // actor 的升级通道。与 submit_result 完全同构：
  // 端口在场即注册（includeEscalate），`tools:"none"` 下由 workflow_child 的 allowlist
  // 补回逻辑救回来。不入 actor 的默认 disallow——最可能撞上未预见之墙的 actor 恰是
  // 作者没标记的那一个。
  escalateToolEntry,
  taskOutputToolEntry,
  taskStopToolEntry,
  readSessionContextToolEntry,
  // 外部会话只读互操作（specs/external-sessions.md）：always-on 只读工具。
  listExternalSessionsToolEntry,
  readExternalSessionToolEntry,
  agentToolEntry,
  taskToolEntry,
  skillToolEntry,
  jsToolEntry,
  createWorkflowToolEntry,
  amendWorkflowToolEntry,
  // 保存的定义：写侧 gate 与 CreateWorkflow 同档（alwaysAsk），读侧无 gate。
  saveWorkflowToolEntry,
  // workflow 创作的实验通道：同步、只读（v1）、完全瞬态。
  evalWorkflowSnippetToolEntry,
  // run 内省的两个只读工具：always-on、无 gate。它们不进 WORKFLOW_CHILD_DISALLOWED_TOOLS——
  // 那条禁令的理由是 CreateWorkflow 的 alwaysAsk 在子 runtime 里无窗可弹，只读查询不适用。
  listWorkflowRunsToolEntry,
  getWorkflowRunToolEntry,
  // run 的恢复入口：与上面两个只读内省工具同族（run_id 键、端口探测失败同款），但它是
  // 执行语义——alwaysAsk 非 yolo 不可（cancelled 是用户的显式停止决定，复活必须先问），
  // 因此须进 WORKFLOW_CHILD_DISALLOWED_TOOLS（child yolo 无窗可弹）。插在 GetWorkflowRun 之后：run 工具簇 list/get/resume 相邻。
  resumeWorkflowRunToolEntry,
  // 升级问答的主代理侧：与上面三个 run 工具同族——
  // 同一个 dwf run 端口、同款 typeof 探测失败。与它们的不同点在下游：它进 actor 会话的
  // 禁用名单（bootstrap 的 workflowActorToolPolicy），子代理不许替主代理作答。
  resolveWorkflowQuestionToolEntry,
  // 定义清单（与上面两个 run 工具是两件事：那是历史，这是可跑的东西）。同为只读、无 gate。
  listSavedWorkflowsToolEntry,
  // 模型目录：同为只读、无 gate 的发现面，服务于 CreateWorkflow / AmendWorkflow 的
  // `subagent_model`。不进 WORKFLOW_CHILD_DISALLOWED_TOOLS
  // ——那条禁令的理由是 alwaysAsk 在 child 里无窗可弹，只读查询不适用。
  listModelsToolEntry,
  // workflowToolEntry,
];

/**
 * 动态工作流灰度门关闭时不注册的十个工具。
 * 灰度关的语义是「没有任何办法开始一条工作流」，所以创建、修订、保存、快照实验与四个
 * run 面工具一起下架；只读的 run 内省工具也在列，因为关闭态下它们只会指向用户无法再操作的历史。
 * `ListModels` 也在列：它唯一的用途是给一次 run 挑 `subagent_model`，没有 CreateWorkflow 可填时留着它只会把模型引向不存在的工具。
 * 旧的 `Workflow` 工具（`/expert` 脚本通道）是另一个功能，**不在**这份名单里。
 */
const DYNAMIC_WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set([
  CREATE_WORKFLOW_TOOL_NAME,
  AMEND_WORKFLOW_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  LIST_MODELS_TOOL_NAME,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
]);

interface RegisterBuiltInToolsOptions {
  bashTimeoutPolicy?: BashTimeoutPolicy;
  includeSkill?: boolean;
  includeAgent?: boolean;
  includeSendMessage?: boolean;
  includeRespondToCoordinator?: boolean;
  /**
   * Agent Teams 团队管理面（TeamCreate/TeamDelete）：v1 仅主会话（非 subagent_child）
   * 注册，由 runtime-tools 按端口与 runtimeScope 推导传入。
   */
  includeTeam?: boolean;
  /** Agent Teams 共享任务面（TaskCreate/TaskUpdate/TaskGet/TaskList）：lead 与 teammate 都可用。 */
  includeTeamTasks?: boolean;
  /**
   * 会话互聊（实验）：SessionList/SessionTalk/SessionCreate。门与 off-peak 同款
   * ——只在宿主注入了 SessionChatPort 的会话注册；subagent_child 不暴露（无嵌套互聊）。
   */
  includeSessionChat?: boolean;
  /** agent 可调桌面设置（specs/agent-settings.md）：Get/SetDesktopSetting，端口在场才注册。 */
  includeDesktopSettings?: boolean;
  /** 图像工具（specs/image-tools.md）：image_gen/image_edit，端口在场才注册。 */
  includeImageTools?: boolean;
  /** 语音工具（specs/voice-pipeline.md）：asr_transcribe/tts_speech，端口在场才注册。 */
  includeVoiceTools?: boolean;
  /** PDF 预览联动（specs/pdf-preview-linkage.md）：pdf_locate，桌面形态门显式开启才注册。 */
  includePdfLocate?: boolean;
  includeSubmitResult?: boolean;
  /**
   * 在场时 submit_result 以 typed 声明注册（`{ result: <schema> }`，strict 资格），供 dwf mono
   * 子代理；缺席即通用声明。只在 includeSubmitResult 为真时有意义。
   */
  submitResultSchema?: JsonSchema;
  /** actor 的升级通道；门与 includeSubmitResult 同款（注入了 WorkflowEscalatePort 才注册）。 */
  includeEscalate?: boolean;
  includeWorkflow?: boolean;
  includeAutomation?: boolean;
  /** Off-Peak 会话内创建工具面；由 host 的 offPeakToolEnabled flag（灰度/远程门）驱动。 */
  includeOffPeak?: boolean;
  /**
   * 动态工作流灰度门。**只有显式 false
   * 才下架** DYNAMIC_WORKFLOW_TOOL_NAMES：缺席代表调用方不参与灰度（TUI、headless、
   * workflow_child），它们必须保留全部工具面；fail-closed 的缺省值落在协议服务端的
   * appRuntimePreferences，不在这一层。
   */
  includeDynamicWorkflow?: boolean;
  /** node_repl（js）默认关闭，由官方 browser-use 插件启用。 */
  includeNodeRepl?: boolean;
  /** browser-use 说明和 agent.browsers 注入由官方 browser-use 插件 + 宿主 browser bridge 共同启用。 */
  includeBrowserUse?: boolean;
  embeddedSearchEnabled?: boolean;
  agentProfiles?: readonly AgentProfile[];
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  silentDuplicateWarnings?: boolean;
}

export function registerBuiltInTools(
  registry: {
    register(entry: ToolEntry, options?: { silentDuplicateWarning?: boolean }): void;
  },
  options: RegisterBuiltInToolsOptions = {},
): void {
  const allowedTools = options.allowedTools ? new Set(options.allowedTools) : undefined;
  const disallowedTools = createToolRuleNameSet(options.disallowedTools);

  for (const entry of builtInTools) {
    if (
      options.embeddedSearchEnabled === true &&
      (entry.metadata.name === "Glob" || entry.metadata.name === "Grep")
    ) {
      continue;
    }
    if (allowedTools && !allowedTools.has(entry.metadata.name)) {
      continue;
    }
    if (disallowedTools?.has(entry.metadata.name)) {
      continue;
    }
    if (isSubagentDispatchToolName(entry.metadata.name) && options.includeAgent !== true) {
      continue;
    }
    if (entry.metadata.name === "Skill" && options.includeSkill === false) {
      continue;
    }
    if (entry.metadata.name === "SendMessage" && options.includeSendMessage !== true) {
      continue;
    }
    if (
      (entry.metadata.name === "TeamCreate" ||
        entry.metadata.name === "TeamDelete" ||
        entry.metadata.name === "TeamPlan" ||
        entry.metadata.name === "TeamPlanApprove") &&
      options.includeTeam !== true
    ) {
      continue;
    }
    if (
      (entry.metadata.name === "TaskCreate" ||
        entry.metadata.name === "TaskUpdate" ||
        entry.metadata.name === "TaskGet" ||
        entry.metadata.name === "TaskList" ||
        entry.metadata.name === "TeamKnowledgeWrite" ||
        entry.metadata.name === "TeamKnowledgeSearch" ||
        entry.metadata.name === "TeamKnowledgePromote") &&
      options.includeTeamTasks !== true
    ) {
      continue;
    }
    if (
      (entry.metadata.name === "SessionList" ||
        entry.metadata.name === "SessionTalk" ||
        entry.metadata.name === "SessionCreate") &&
      options.includeSessionChat !== true
    ) {
      continue;
    }
    if (
      (entry.metadata.name === GET_DESKTOP_SETTING_TOOL_NAME ||
        entry.metadata.name === SET_DESKTOP_SETTING_TOOL_NAME) &&
      options.includeDesktopSettings !== true
    ) {
      continue;
    }
    if (
      (entry.metadata.name === IMAGE_GEN_TOOL_NAME || entry.metadata.name === IMAGE_EDIT_TOOL_NAME) &&
      options.includeImageTools !== true
    ) {
      continue;
    }
    if (
      (entry.metadata.name === ASR_TRANSCRIBE_TOOL_NAME ||
        entry.metadata.name === TTS_SPEECH_TOOL_NAME) &&
      options.includeVoiceTools !== true
    ) {
      continue;
    }
    if (entry.metadata.name === PDF_LOCATE_TOOL_NAME && options.includePdfLocate !== true) {
      continue;
    }
    if (
      entry.metadata.name === "RespondToCoordinator" &&
      options.includeRespondToCoordinator !== true
    ) {
      continue;
    }
    if (entry.metadata.name === "submit_result" && options.includeSubmitResult !== true) {
      continue;
    }
    if (entry.metadata.name === "escalate" && options.includeEscalate !== true) {
      continue;
    }
    if (entry.metadata.name === "Workflow" && options.includeWorkflow !== true) {
      continue;
    }
    if (
      (entry.metadata.name === "CronCreate" ||
        entry.metadata.name === "CronList" ||
        entry.metadata.name === "CronUpdate" ||
        entry.metadata.name === "CronDelete") &&
      options.includeAutomation !== true
    ) {
      continue;
    }
    if (
      (entry.metadata.name === "OffPeakCreate" || entry.metadata.name === "OffPeakList") &&
      options.includeOffPeak !== true
    ) {
      continue;
    }
    if (
      options.includeDynamicWorkflow === false &&
      DYNAMIC_WORKFLOW_TOOL_NAMES.has(entry.metadata.name)
    ) {
      continue;
    }
    if (entry.metadata.name === "js" && options.includeNodeRepl !== true) {
      continue;
    }
    registry.register(resolveBuiltInToolEntryForBranch(entry, options), {
      silentDuplicateWarning: options.silentDuplicateWarnings,
    });
  }
}

function resolveBuiltInToolEntryForBranch(
  entry: ToolEntry,
  options: RegisterBuiltInToolsOptions,
): ToolEntry {
  if (entry.metadata.name === "Bash") {
    return createBashToolEntry({
      bashTimeoutPolicy: options.bashTimeoutPolicy,
      embeddedSearchEnabled: options.embeddedSearchEnabled,
    });
  }
  if (entry.metadata.name === SUBMIT_RESULT_TOOL_NAME && options.submitResultSchema !== undefined) {
    return createSubmitResultToolEntry(options.submitResultSchema);
  }
  // 灰度门同时管工具面和**描述**：Agent / Task 的描述里有一条「工作流请求必须改用
  // CreateWorkflow」，关闭时那个工具不存在，留着只会把模型指向不存在的工具。用的是与注册过滤同一个
  // options.includeDynamicWorkflow，所以首次装配与分支刷新产出的描述必然一致。
  if (entry.metadata.name === "Agent") {
    return createAgentToolEntry({
      embeddedSearchEnabled: options.embeddedSearchEnabled,
      profiles: options.agentProfiles,
      dynamicWorkflowEnabled: options.includeDynamicWorkflow !== false,
    });
  }
  if (entry.metadata.name === "Task") {
    return createTaskToolEntry({
      embeddedSearchEnabled: options.embeddedSearchEnabled,
      profiles: options.agentProfiles,
      dynamicWorkflowEnabled: options.includeDynamicWorkflow !== false,
    });
  }
  if (entry.metadata.name === "EnterPlanMode") {
    return createEnterPlanModeToolEntry({
      embeddedSearchEnabled: options.embeddedSearchEnabled,
    });
  }
  if (entry.metadata.name === "js") {
    return createJsToolEntry({
      browserUseEnabled: options.includeBrowserUse === true,
    });
  }
  return entry;
}
