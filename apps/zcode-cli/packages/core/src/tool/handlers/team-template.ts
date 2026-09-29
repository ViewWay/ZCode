// ============================================================
// TeamCreate 角色模板解析（v2.8）
// ============================================================
//
// 模板文件：<workspaceRoot>/.zcode/team-templates/<name>.md
// 格式（行式 markdown）：
//   ---
//   description: 团队用途
//   ---
//   ## member: <name>
//   <成员 prompt，可多行>
//   ## task: <subject>
//   owner: <name>
//   depends: <task subject>, <task subject>
//   <任务描述正文，可多行>
//
// 解析结果经 TeamCreate 输出 templatePlan 回灌 lead 模型，按剧本
// Agent spawn 成员 + TaskCreate 建任务实例化团队。文件 IO 收敛在本文件。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isSafeTeamPathSegment } from "../../subagent/team/team-paths.js";

export interface TeamTemplateMember {
  name: string;
  prompt: string;
}

export interface TeamTemplateTask {
  subject: string;
  owner?: string;
  depends: string[];
  detail: string;
}

export interface ParsedTeamTemplate {
  description?: string;
  members: TeamTemplateMember[];
  tasks: TeamTemplateTask[];
}

const TEMPLATE_NAME_MAX_CHARS = 64;
const TEMPLATE_MAX_SECTIONS = 32;

export async function readTeamTemplate(workspaceRoot: string, templateName: string): Promise<ParsedTeamTemplate> {
  if (!isSafeTeamPathSegment(templateName, TEMPLATE_NAME_MAX_CHARS)) {
    throw new Error("Invalid team template name: " + templateName);
  }
  const file = join(workspaceRoot, ".zcode", "team-templates", templateName + ".md");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error("Team template not found: " + templateName + " (expected " + file + ")");
  }
  const parsed = parseTeamTemplate(raw);
  if (parsed.members.length + parsed.tasks.length > TEMPLATE_MAX_SECTIONS) {
    throw new Error("Team template has too many sections (max " + TEMPLATE_MAX_SECTIONS + ")");
  }
  return parsed;
}

/** 行式解析：frontmatter description、## member: / ## task: 段及其正文。 */
export function parseTeamTemplate(raw: string): ParsedTeamTemplate {
  const result: ParsedTeamTemplate = { members: [], tasks: [] };
  let description: string | undefined;
  let section: { kind: "member" | "task"; name: string } | undefined;
  let sectionLines: string[] = [];
  let sawHeading = false;

  const flush = (): void => {
    if (section === undefined) return;
    const body = sectionLines.join("\n").trim();
    if (section.kind === "member") {
      result.members.push({ name: section.name, prompt: body });
    } else {
      let owner: string | undefined;
      let depends: string[] = [];
      const detailLines: string[] = [];
      for (const line of sectionLines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("owner:")) owner = trimmed.slice("owner:".length).trim();
        else if (trimmed.startsWith("depends:")) {
          depends = trimmed.slice("depends:".length)
            .split(",")
            .map((x) => x.trim())
            .filter((x) => x.length > 0);
        } else detailLines.push(line);
      }
      result.tasks.push({ subject: section.name, owner, depends, detail: detailLines.join("\n").trim() });
    }
    section = undefined;
    sectionLines = [];
  };

  for (const line of raw.split("\n")) {
    if (line.startsWith("description:") && !sawHeading) {
      description = line.slice("description:".length).trim();
      continue;
    }
    if (line.startsWith("---")) continue;
    const memberMatch = line.match(/^##\s+member:\s*(.+)$/);
    if (memberMatch) {
      flush();
      sawHeading = true;
      section = { kind: "member", name: memberMatch[1].trim() };
      continue;
    }
    const taskMatch = line.match(/^##\s+task:\s*(.+)$/);
    if (taskMatch) {
      flush();
      sawHeading = true;
      section = { kind: "task", name: taskMatch[1].trim() };
      continue;
    }
    if (section !== undefined) sectionLines.push(line);
  }
  flush();
  if (result.members.length === 0 && result.tasks.length === 0) {
    throw new Error("Team template has no '## member:' or '## task:' sections");
  }
  if (description !== undefined) result.description = description;
  return result;
}
