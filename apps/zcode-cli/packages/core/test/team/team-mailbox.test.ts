// Mailbox 单测：顺序投递、确认读、广播隔离（AC3）

import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";

import {
  addTeamMember,
  createOrGetTeam,
  loadTeamFile,
} from "../../src/subagent/team/team-store.js";
import {
  appendTeamInboxMessage,
  broadcastTeamMessage,
  buildTeamMailboxMessage,
  readTeamInbox,
} from "../../src/subagent/team/team-mailbox.js";
import { teamTest } from "./helpers.js";

test("mailbox preserves order per member and supports confirmed read", async () => {
  await createOrGetTeam(teamTest.deps, {
    name: "mail-team",
    leadAgentId: "lead_s1",
    leadWorkingDirectory: "/workspaces/demo",
  });
  for (let i = 0; i < 3; i++) {
    await appendTeamInboxMessage(
      teamTest.dirs,
      "mail-team",
      "bob",
      buildTeamMailboxMessage({ from: "alice", to: "bob", payload: { kind: "text", text: `m${i}` } }),
    );
  }
  const unread = await readTeamInbox(teamTest.dirs, "mail-team", "bob");
  assert.equal(unread.messages.length, 3);
  assert.deepEqual(
    unread.messages.map((message) => (message.payload as { text: string }).text),
    ["m0", "m1", "m2"],
  );
  assert.equal(unread.messages.every((message) => !message.read), true);

  // 确认读：本次返回「已消费」视角，磁盘事实同步落 read 标志
  const confirmed = await readTeamInbox(teamTest.dirs, "mail-team", "bob", { markRead: true });
  assert.equal(confirmed.messages.every((message) => message.read), true);
  const reread = await readTeamInbox(teamTest.dirs, "mail-team", "bob");
  assert.equal(reread.messages.every((message) => message.read), true);
});

test("broadcast skips the sender and isolates per-member failures (AC3)", async () => {
  // 团队：lead（发送者）+ carol（收件箱被破坏）+ dave（正常）
  await createOrGetTeam(teamTest.deps, {
    name: "fanout-team",
    leadAgentId: "lead_s1",
    leadWorkingDirectory: "/workspaces/demo",
  });
  for (const name of ["carol", "dave"]) {
    await addTeamMember(teamTest.deps, "fanout-team", {
      agentId: `agent_${name}`,
      name,
      cwd: "/workspaces/demo",
      isActive: false,
      joinedAt: new Date().toISOString(),
    });
  }
  const fanout = (await loadTeamFile(teamTest.deps, "fanout-team"))!;
  const carolInbox = teamTest.dirs.teamInboxFile("fanout-team", "carol");
  await appendTeamInboxMessage(
    teamTest.dirs,
    "fanout-team",
    "carol",
    buildTeamMailboxMessage({ from: "lead", to: "carol", payload: { kind: "text", text: "prime" } }),
  );
  // 把 carol 的收件箱文件换成同名目录，使 rename 落盘必然失败
  const carolRaw = await readFile(carolInbox, "utf8");
  await rm(carolInbox);
  await writeFile(carolInbox, carolRaw);
  await rm(carolInbox);
  await mkdir(carolInbox);

  const result = await broadcastTeamMessage(teamTest.dirs, "fanout-team", fanout, {
    from: "team_lead",
    payload: { kind: "text", text: "hello" },
    sentAt: new Date().toISOString(),
  });
  // carol 失败但 dave 不被阻断；lead 是发送者被跳过
  assert.deepEqual(result.deliveredTo, ["dave"]);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]!.member, "carol");
  const daveInbox = await readTeamInbox(teamTest.dirs, "fanout-team", "dave");
  assert.equal((daveInbox.messages[0]!.payload as { text: string }).text, "hello");
});
