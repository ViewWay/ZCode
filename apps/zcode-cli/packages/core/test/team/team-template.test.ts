// 团队角色模板解析单测(v2.8)

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseTeamTemplate, readTeamTemplate } from "../../src/tool/handlers/team-template.js";

test("parseTeamTemplate: members, tasks, owner and depends", () => {
  const parsed = parseTeamTemplate([
    "description: 前后端团队",
    "---",
    "## member: backend",
    "你负责后端实现",
    "## member: frontend",
    "你负责前端实现",
    "## task: 初始化项目结构",
    "owner: backend",
    "建立目录骨架",
    "## task: 联调测试",
    "owner: frontend",
    "depends: 初始化项目结构",
    "端到端联调",
  ].join("\n"));
  assert.equal(parsed.description, "前后端团队");
  assert.equal(parsed.members.length, 2);
  assert.equal(parsed.members[0].name, "backend");
  assert.match(parsed.members[0].prompt, /后端实现/);
  assert.equal(parsed.tasks.length, 2);
  assert.equal(parsed.tasks[0].owner, "backend");
  assert.equal(parsed.tasks[1].depends[0], "初始化项目结构");
  assert.match(parsed.tasks[1].detail, /联调/);
});

test("readTeamTemplate: reads from .zcode/team-templates and rejects unknown/unsafe names", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "tpl-"));
  const dir = join(workspaceRoot, ".zcode", "team-templates");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "demo.md"), "## member: solo\n单兵模式\n", "utf8");

  const parsed = await readTeamTemplate(workspaceRoot, "demo");
  assert.equal(parsed.members[0].name, "solo");

  await assert.rejects(readTeamTemplate(workspaceRoot, "missing"), /not found/);
  await assert.rejects(readTeamTemplate(workspaceRoot, "../escape"), /Invalid team template name/);
});
