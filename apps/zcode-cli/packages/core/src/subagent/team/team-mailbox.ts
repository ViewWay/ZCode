// ============================================================
// Agent Teams - teammate 邮箱（inboxes/<member>.json）
// ============================================================
//
// specs/agent-teams.md 消息与邮箱约定：
//   - 每个成员一个收件箱文件；写入持文件锁，多写者互斥；
//   - 投递语义：至多一次 + 确认读（read 标志）；
//   - 广播对每个成员独立落盘，单成员失败不阻断其他成员；
//   - 消息载荷：纯文本 / shutdown_request / idle_notification（plan_approval 配对在
//     teammate 运行时接入时补充，存储 schema 先行承载）。

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { TEAM_MEMBER_NAME_MAX_CHARS, type TeamFile, type TeamMember } from "@zcode/contracts";
import type { TeamWorkspaceDirs } from "./team-paths.js";
import { isSafeTeamPathSegment } from "./team-paths.js";
import { readJsonFileSafe } from "./team-json-file.js";
import { withTeamFileLock } from "./team-lock.js";

const INBOX_ATOMIC_TMP_SUFFIX = ".tmp";

export type TeamMailboxPayload =
  | { kind: "text"; text: string }
  | { kind: "shutdown_request"; reason?: string }
  | { kind: "idle_notification" }
  | { kind: "plan_approval_request"; requestId: string; planSummary: string }
  | { kind: "plan_approval_response"; requestId: string; approve: boolean };

export interface TeamMailboxMessage {
  id: string;
  from: string;
  to: string;
  summary?: string;
  payload: TeamMailboxPayload;
  sentAt: string;
  read: boolean;
}

export interface AppendTeamMessageParams {
  from: string;
  to: string;
  payload: TeamMailboxPayload;
  summary?: string;
  now?: () => Date;
}

export function buildTeamMailboxMessage(params: AppendTeamMessageParams): TeamMailboxMessage {
  return {
    id: randomUUID(),
    from: params.from,
    to: params.to,
    payload: params.payload,
    ...(params.summary === undefined ? {} : { summary: params.summary }),
    sentAt: (params.now ?? (() => new Date()))().toISOString(),
    read: false,
  };
}

export interface TeamInboxReadResult {
  messages: TeamMailboxMessage[];
}

/** 读取收件箱；markRead 时在同一把锁内回写 read 标志（确认读），返回已消费视角的消息。 */
export async function readTeamInbox(
  dirs: TeamWorkspaceDirs,
  teamName: string,
  memberName: string,
  options: { markRead?: boolean } = {},
): Promise<TeamInboxReadResult> {
  assertSafeMemberName(memberName);
  const inboxFile = dirs.teamInboxFile(teamName, memberName);
  return withTeamFileLock(inboxFile, async () => {
    const messages = await readInboxFile(inboxFile);
    if (options.markRead === true && messages.some((message) => !message.read)) {
      const confirmed = messages.map((message) => ({ ...message, read: true }));
      await writeInboxFile(inboxFile, confirmed);
      // 返回确认读之后的视角：调用方看到的就是「已消费」状态，与磁盘事实一致。
      return { messages: confirmed };
    }
    return { messages };
  });
}

/** 单发投递：追加到目标成员收件箱，持锁写入；返回消息 id。 */
export async function appendTeamInboxMessage(
  dirs: TeamWorkspaceDirs,
  teamName: string,
  memberName: string,
  message: TeamMailboxMessage,
): Promise<string> {
  assertSafeMemberName(memberName);
  const inboxFile = dirs.teamInboxFile(teamName, memberName);
  return withTeamFileLock(inboxFile, async () => {
    const messages = await readInboxFile(inboxFile);
    await writeInboxFile(inboxFile, [...messages, message]);
    return message.id;
  });
}

export interface BroadcastResult {
  /** 成功投递的成员名（发送者除外）。 */
  deliveredTo: string[];
  /** 单成员失败明细；广播不因个别成员失败而中断。 */
  failures: Array<{ member: string; error: string }>;
}

/**
 * 广播：遍历 TeamFile 全部成员逐一投递（发送者除外）。
 * 单成员写失败不阻断其余成员（AC3）；每条消息独立生成 id 独立落盘。
 */
export async function broadcastTeamMessage(
  dirs: TeamWorkspaceDirs,
  teamName: string,
  team: Pick<TeamFile, "members">,
  message: Omit<TeamMailboxMessage, "id" | "to" | "read">,
): Promise<BroadcastResult> {
  const deliveredTo: string[] = [];
  const failures: BroadcastResult["failures"] = [];
  for (const member of team.members) {
    if (member.name === message.from) continue;
    const memberMessage: TeamMailboxMessage = {
      ...message,
      id: randomUUID(),
      to: member.name,
      read: false,
    };
    try {
      await appendTeamInboxMessage(dirs, teamName, member.name, memberMessage);
      deliveredTo.push(member.name);
    } catch (error) {
      failures.push({ member: member.name, error: (error as Error).message });
    }
  }
  return { deliveredTo, failures };
}

async function readInboxFile(inboxFile: string): Promise<TeamMailboxMessage[]> {
  const raw = await readJsonFileSafe(inboxFile);
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`Team inbox is not a message array: ${inboxFile}`);
  }
  return raw as TeamMailboxMessage[];
}

async function writeInboxFile(inboxFile: string, messages: TeamMailboxMessage[]): Promise<void> {
  await mkdir(dirname(inboxFile), { recursive: true });
  const tmpFile = `${inboxFile}${INBOX_ATOMIC_TMP_SUFFIX}`;
  await writeFile(tmpFile, `${JSON.stringify(messages, null, 2)}\n`, "utf8");
  await rename(tmpFile, inboxFile);
}

function assertSafeMemberName(memberName: string): void {
  if (!isSafeTeamPathSegment(memberName, TEAM_MEMBER_NAME_MAX_CHARS)) {
    throw new Error(`Invalid teammate name: ${memberName}`);
  }
}

/** 便捷构造：从 TeamFile 找成员（SendMessage 路由用）。 */
export function findTeamMember(
  team: Pick<TeamFile, "members">,
  memberName: string,
): TeamMember | undefined {
  return team.members.find((member) => member.name === memberName);
}
