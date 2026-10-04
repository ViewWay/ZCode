// 会话结束自动沉淀触发器（specs/auto-distill.md 的"会话结束后台提取"增量）。
// 触发点：session-facade 的 close() 在 closeSessionResources 之前调用本函数——
// 此时 session store 尚未关闭，durable messages 还能读取；读取→映射→提取→store.add
// 全程被 try/catch 包住，任何失败只记 warn，不影响会话正常结束（验收场景 3）。
// 映射规则：真实用户输入（realUserInput 投影策略）与 assistant 可见 text 片段按
// part 顺序进提取器；Bash 工具的 input.command 注成行内反引号片段，喂给提取器
// 的"行内代码命令"信号（与 core extract 的三类低噪命令来源对齐）。
// 频控：同会话只触发一次（进程内 Set）；宿主重启后即使重放也是幂等的——
// 提取是纯函数且确定性，store.add 按 id upsert 不产生重复候选。
// 运行测试：cd <repo-root> && ./node_modules/.bin/tsx --test apps/zcode-cli/packages/bootstrap/test/distill-close-trigger.test.ts

import type {
  Logger,
  MessagePart,
  MessageWithParts,
  SessionId,
  SessionStorePort,
} from "@zcode/contracts";
import { extractDistillCandidates } from "@zcode/core";
import { getConversationMessageProjectionPolicy } from "@zcode/shared";
import type {
  DistillCandidate,
  DistillSessionFragment,
  DistillSessionInput,
} from "@zcode/shared";
import {
  createDistillCandidateStore,
  type DistillCandidateStore,
} from "@zcode/shared/node";

/** durable 工具片段里的 Bash 工具名（core tool registry 的注册名）。 */
const BASH_TOOL_NAME = "Bash";

/** 频控 Set 的容量上限：超限时整体清空。会话 id 不可枚举，淘汰精度无关紧要。 */
const TRIGGERED_SESSIONS_LIMIT = 1024;

/** 已触发过会话结束提取的会话（进程内频控；不做持久化，重复触发本就幂等）。 */
const triggeredSessionIds = new Set<SessionId>();

export interface SessionCloseDistillTriggerDeps {
  sessionId: SessionId;
  sessionStore: Pick<SessionStorePort, "messages">;
  /** 会话工作区本地路径：随候选落盘，设置页"确认"按它复现项目记忆目录。 */
  workingDirectory: string;
  /** 命名/远程工作区身份；与 AGENTS.md Workspace Identity 的 key 规则一致（trim 后为空则忽略）。 */
  workspaceIdentity?: string;
  logger: Pick<Logger, "info" | "warn">;
  /** 候选存储注入（测试用）；缺省写用户级 ~/.zcode/distill/candidates.json。 */
  store?: DistillCandidateStore;
}

/**
 * durable messages → 提取输入。纯函数，供触发器与单测共用；
 * 只取用户可见信号：model-only 输入与 compact 摘要不进提取器（会伪造采纳信号）。
 */
export function mapDurableMessagesToDistillInput(input: {
  sessionId: string;
  messages: readonly MessageWithParts[];
}): DistillSessionInput {
  const fragments: DistillSessionFragment[] = [];
  for (const message of input.messages) {
    if (message.info.role === "user") {
      // goal 续跑、todo 提醒等 runtime 内部输入不是用户发言；compact 摘要同理。
      if (getConversationMessageProjectionPolicy(message) !== "realUserInput") continue;
      if (message.info.summary !== undefined) continue;
    } else if (message.info.summary === true) {
      continue;
    }

    for (const part of dedupePartsById(message.parts)) {
      const fragment = distillFragmentFromPart(message.info.role, part);
      if (fragment) fragments.push(fragment);
    }
  }
  return { sessionId: input.sessionId, fragments };
}

/** 同一 part id 只取最后一次状态（与 transcript 投影一致，防重复计数命令出现次数）。 */
function dedupePartsById(parts: readonly MessagePart[]): MessagePart[] {
  const byId = new Map<string, MessagePart>();
  for (const part of parts) byId.set(part.id, part);
  return [...byId.values()];
}

function distillFragmentFromPart(
  role: "user" | "assistant",
  part: MessagePart,
): DistillSessionFragment | undefined {
  if (part.type === "text" && !part.ignored && part.text.trim().length > 0) {
    return { role, text: part.text };
  }
  if (part.type === "tool" && part.tool === BASH_TOOL_NAME) {
    const command = readBashCommandInput(part.state.input);
    if (command) {
      // 行内反引号包裹：core extract 只从围栏块、`$ ` 提示符行与行内代码识别命令。
      return { role, text: `\`${command}\`` };
    }
  }
  return undefined;
}

/** Bash 工具 input.command；缺失或非字符串（异常调用）不算命令信号。 */
function readBashCommandInput(input: Record<string, unknown>): string | undefined {
  const command = input.command;
  return typeof command === "string" && command.trim().length > 0 ? command : undefined;
}

/** 会话结束触发入口；自身保证不抛错（验收场景 3），失败只记生产 warn。 */
export async function runSessionCloseDistillTrigger(
  deps: SessionCloseDistillTriggerDeps,
): Promise<void> {
  if (triggeredSessionIds.has(deps.sessionId)) return;
  if (triggeredSessionIds.size >= TRIGGERED_SESSIONS_LIMIT) triggeredSessionIds.clear();
  triggeredSessionIds.add(deps.sessionId);

  try {
    const messages = await deps.sessionStore.messages({ sessionID: deps.sessionId });
    const sessionInput = mapDurableMessagesToDistillInput({
      sessionId: deps.sessionId,
      messages,
    });
    const extracted = extractDistillCandidates([sessionInput]);
    if (extracted.length === 0) return;

    // 候选补齐来源工作区：确认动作跨进程复现项目记忆目录的唯一依据。
    const workspaceIdentity = deps.workspaceIdentity?.trim();
    const workspace = {
      ...(workspaceIdentity ? { identity: workspaceIdentity } : {}),
      path: deps.workingDirectory,
    };
    const candidates: DistillCandidate[] = extracted.map((candidate) => ({
      ...candidate,
      workspace,
    }));

    const store = deps.store ?? createDistillCandidateStore();
    await store.add(candidates);
    deps.logger.info("Session close distill extraction completed", {
      candidateCount: candidates.length,
      event: "auto_distill.trigger.completed",
      module: "bootstrap.app",
      sessionId: deps.sessionId,
      status: "completed",
    });
  } catch (error) {
    // 验收场景 3：提取链路任何失败（读消息、提取、候选落盘）都不能影响会话正常结束。
    deps.logger.warn("Session close distill extraction failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "auto_distill.trigger.failed",
      module: "bootstrap.app",
      sessionId: deps.sessionId,
      status: "failed",
    });
  }
}
