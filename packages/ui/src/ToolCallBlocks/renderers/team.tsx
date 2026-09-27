// Agent Teams 工具渲染器（specs/agent-teams.md）：family = team 的 6 个工具共用一张卡。
// TeamCreate/TeamDelete 展示团队身份；TaskCreate/TaskUpdate/TaskGet/TaskList 展示共享任务
// 的读写动作。只读展示，不发任何请求——团队事实源在 runtime 的 TeamFile/tasks.json。

import { UsersIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const TEAM_TOOL_ICON = <UsersIcon className="size-4 shrink-0 text-foreground-subtle" />;

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readStringField(
  value: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return undefined;
}

const KIND_LABEL_BY_TOOL: Record<string, string> = {
  TeamCreate: "chat.toolCall.kind.teamCreate",
  TeamDelete: "chat.toolCall.kind.teamDelete",
  TaskCreate: "chat.toolCall.kind.teamTaskCreate",
  TaskUpdate: "chat.toolCall.kind.teamTaskUpdate",
  TaskGet: "chat.toolCall.kind.teamTaskGet",
  TaskList: "chat.toolCall.kind.teamTaskList",
};

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <dt className="text-ui-base font-medium text-foreground-subtle">{label}</dt>
      <dd className="whitespace-pre-wrap break-words text-ui-base leading-5 text-foreground">
        {value}
      </dd>
    </div>
  );
}

export function TeamToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const input = toRecord(toolCall.input) ?? toRecord(toolCall.raw);
  const output = toRecord(toolCall.output);

  const teamName = readStringField(input, ["name", "team_name"]);
  const description = readStringField(input, ["description"]);
  const taskSubject = readStringField(input, ["subject"]);
  const taskId =
    readStringField(input, ["taskId", "task_id"]) ?? readStringField(output, ["taskId", "task_id"]);
  const taskStatus = readStringField(input, ["status"]);
  const owner = readStringField(input, ["owner"]);

  const resultText =
    context.errorText ?? readStringField(output, ["message", "summary", "result"]);

  const kindLabelId = KIND_LABEL_BY_TOOL[toolCall.toolName ?? ""] ?? "chat.toolCall.kind.teamCreate";
  const isFailed = toolCall.status === "failed" || toolCall.status === "denied";
  const statusLabelId = isFailed ? "chat.toolCall.status.failed" : undefined;

  const primaryText = useMemo(
    () => <code className="min-w-0 truncate font-mono">{teamName ?? taskSubject ?? taskId ?? toolCall.toolName ?? "Teams"}</code>,
    [teamName, taskSubject, taskId, toolCall.toolName],
  );

  const hasDetails = Boolean(description || taskStatus || owner || resultText);
  const renderContent = useCallback(
    () => (
      <div className="rounded-lg border border-border bg-panel px-4 py-3">
        <dl className="space-y-3">
          {teamName && toolCall.toolName !== "TeamCreate" && toolCall.toolName !== "TeamDelete" ? (
            <DetailField label={intl.formatMessage({ id: "chat.toolCall.team.teamName" })} value={teamName} />
          ) : null}
          {description ? (
            <DetailField label={intl.formatMessage({ id: "chat.toolCall.team.description" })} value={description} />
          ) : null}
          {taskId ? (
            <DetailField label={intl.formatMessage({ id: "chat.toolCall.team.taskId" })} value={taskId} />
          ) : null}
          {taskStatus ? (
            <DetailField label={intl.formatMessage({ id: "chat.toolCall.team.status" })} value={taskStatus} />
          ) : null}
          {owner ? (
            <DetailField label={intl.formatMessage({ id: "chat.toolCall.team.owner" })} value={owner} />
          ) : null}
          {resultText ? (
            <DetailField label={intl.formatMessage({ id: "chat.toolCall.team.result" })} value={resultText} />
          ) : null}
        </dl>
      </div>
    ),
    [description, intl, owner, resultText, taskId, taskStatus, teamName, toolCall.toolName],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={TEAM_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        kindLabel={intl.formatMessage({ id: kindLabelId })}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={statusLabelId ? intl.formatMessage({ id: statusLabelId }) : undefined}
        showStatusLabel={statusLabelId != null}
        statusTooltip={isFailed ? resultText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={context.isRunning}
        title={toolCall.title}
        renderContent={hasDetails ? renderContent : undefined}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
