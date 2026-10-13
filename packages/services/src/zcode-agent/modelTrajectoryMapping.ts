import type {
  ZCodeModelTrajectoryCallSource,
  ZCodeModelTrajectoryContentPart,
  ZCodeModelTrajectoryMessage,
  ZCodeModelTrajectoryRecord,
  ZCodeModelTrajectoryUsage,
} from "#src/session/zcodeTaskService.js";

// 从 modelTrajectory.ts 拆出（修复原因：oxlint max-lines 上限 400，单文件 613 行超限）。
// 本文件只负责“model-io JSONL 原始记录 → UI 轨迹对象”的纯映射与 delta 还原，无 IO 依赖。

const SESSION_TITLE_PROMPT_PREFIX = "Generate a concise title for this coding session.";

export function toTime(value?: string): number {
  if (!value) {
    return 0;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

export function mapRecord(record: Record<string, unknown>): ZCodeModelTrajectoryRecord {
  const request = asObject(record.request);
  const response = asObject(record.response);
  const model = asObject(record.model);
  const error = asObject(record.error);
  const querySource = asString(record.querySource) ?? inferQuerySourceFromRequest(request);
  const modelRole = asString(model?.role);

  const mapped: ZCodeModelTrajectoryRecord = {
    requestId: asString(record.requestId) ?? "",
    attempt: asNumber(record.attempt) ?? 1,
    startedAt: asString(record.startedAt) ?? "",
    completedAt: asString(record.completedAt),
    durationMs: asNumber(record.durationMs),
    turnId: asString(record.turnId),
    traceId: asString(record.traceId),
    callSource: classifyCallSource(querySource, modelRole),
    model: {
      modelId: asString(model?.modelId),
      providerId: asString(model?.providerId),
      role: modelRole,
      source: asString(model?.source),
    },
    request: {
      messages: mapMessages(request?.messages),
      toolNames: asStringArray(request?.toolNames),
    },
  };

  if (response) {
    const responseToolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
    mapped.response = {
      finishReason: asString(response.finishReason),
      text: asString(response.text),
      reasoningText: asString(response.reasoningText),
      toolCalls: responseToolCalls.map((toolCall) => mapResponseToolCall(toolCall)),
      usage: mapUsage(response.usage),
      responseId: asString(response.responseId),
      modelId: asString(response.modelId),
    };
  }

  if (error && (asString(error.message) || asString(error.name))) {
    mapped.error = {
      name: asString(error.name) ?? "Error",
      message: asString(error.message) ?? "",
      stack: asString(error.stack),
    };
  }

  return mapped;
}

function inferQuerySourceFromRequest(
  request: Record<string, unknown> | undefined,
): string | undefined {
  const messages = request?.messages;
  if (!Array.isArray(messages)) {
    return undefined;
  }
  const first = asObject(messages[0]);
  if (first?.role !== "system") {
    return undefined;
  }
  const content = asString(first.content);
  return content?.startsWith(SESSION_TITLE_PROMPT_PREFIX) ? "session_title" : undefined;
}

function classifyCallSource(
  querySource: string | undefined,
  modelRole: string | undefined,
): ZCodeModelTrajectoryCallSource {
  if (querySource === "main_turn") {
    return { kind: "main", querySource };
  }
  if (querySource === "subagent") {
    return { kind: "subagent", querySource };
  }
  if (querySource === "compact" || modelRole === "compact") {
    return { kind: "compact", querySource };
  }
  if (querySource) {
    return { kind: "sidecar", querySource };
  }
  if (modelRole === "subagent") {
    return { kind: "subagent" };
  }
  return { kind: "main" };
}

export function expandModelIODeltaRecords(
  records: Record<string, unknown>[],
): Record<string, unknown>[] {
  const expanded: Record<string, unknown>[] = [];
  let previous: Record<string, unknown> | undefined;
  for (const record of records) {
    const next = expandModelIORecord(record, previous);
    expanded.push(next);
    previous = next;
  }
  return expanded;
}

function expandModelIORecord(
  record: Record<string, unknown>,
  previousRecord?: Record<string, unknown>,
): Record<string, unknown> {
  const request = asObject(record.request);
  if (!request) {
    return record;
  }

  return {
    ...record,
    request: expandModelIORequest(request, asObject(previousRecord?.request)),
  };
}

function expandModelIORequest(
  request: Record<string, unknown>,
  previousRequest?: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...request };
  expandMessageCollection(next, previousRequest, {
    collectionKey: "messages",
    kindKey: "messagesKind",
    offsetKey: "messageOffset",
  });
  expandMessageCollection(next, previousRequest, {
    collectionKey: "sdkMessages",
    kindKey: "sdkMessagesKind",
    offsetKey: "sdkMessageOffset",
  });

  const body = asObject(next.body);
  if (body) {
    const nextBody = { ...body };
    expandMessageCollection(
      nextBody,
      asObject(previousRequest?.body),
      {
        collectionKey: "messages",
        kindKey: "bodyMessagesKind",
        offsetKey: "bodyMessageOffset",
      },
      next,
    );
    next.body = nextBody;
  }

  return next;
}

function expandMessageCollection(
  target: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
  keys: {
    collectionKey: string;
    kindKey: string;
    offsetKey: string;
  },
  metadataSource: Record<string, unknown> = target,
): void {
  if (metadataSource[keys.kindKey] === "tail") {
    // model-io 文件超限或进程内缓存丢失后会写最近窗口 baseline。
    // tail 是新的展开起点，不能继续拼接更早历史，否则又会把已裁剪的巨大上下文带回 UI 读取链路。
    return;
  }
  if (metadataSource[keys.kindKey] !== "delta") {
    return;
  }
  const deltaMessages = target[keys.collectionKey];
  const previousMessages = previous?.[keys.collectionKey];
  const offset = asNonNegativeInteger(metadataSource[keys.offsetKey]);
  if (!Array.isArray(deltaMessages) || !Array.isArray(previousMessages) || offset === undefined) {
    return;
  }
  // 新 model-io 为了避免同一 session 内完整上下文梯度重复，只保存 delta；服务层读出时还原给 UI。
  target[keys.collectionKey] = [...previousMessages.slice(0, offset), ...deltaMessages];
}

function mapMessages(value: unknown): ZCodeModelTrajectoryMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    const message = asObject(entry) ?? {};
    const role = asString(message.role) ?? "unknown";
    return {
      role,
      parts: mapContent(message.content, role, {
        toolCallId:
          asString(message.toolCallId) ??
          asString(message.tool_call_id) ??
          asString(message.tool_use_id),
        toolName: asString(message.toolName) ?? asString(message.name),
        isError: message.isError === true || message.is_error === true,
      }),
    };
  });
}

function mapContent(
  content: unknown,
  role?: string,
  messageTool?: { toolCallId?: string; toolName?: string; isError?: boolean },
): ZCodeModelTrajectoryContentPart[] {
  if (typeof content === "string") {
    if (content.length === 0) return [];
    // tool 角色的字符串内容即工具输出，单独标记为 tool-result 便于 UI 区分。
    if (role === "tool") {
      // 实际 model-io 把关联字段放在消息顶层，而 content 只保存字符串结果；
      // 丢掉顶层字段会让 UI 无法把 TOOL 返回关联到对应 tool call。
      return [
        {
          kind: "tool-result",
          toolCallId: messageTool?.toolCallId,
          toolName: messageTool?.toolName,
          // 标准化 model-io 会把 error-text 展平为 content + isError；这里必须还原类型，
          // 否则 UI 只能看到错误字符串，无法显示错误状态。
          output: tryParseJson(content, messageTool?.isError),
        },
      ];
    }
    return [{ kind: "text", text: content }];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content.map((rawPart) => mapPart(rawPart, role === "tool" ? messageTool : undefined));
}

function mapPart(
  rawPart: unknown,
  messageTool?: { toolCallId?: string; toolName?: string; isError?: boolean },
): ZCodeModelTrajectoryContentPart {
  const part = asObject(rawPart);
  if (!part) {
    return { kind: "unknown", raw: rawPart };
  }

  switch (part.type) {
    case "text":
      return { kind: "text", text: asString(part.text) ?? "" };
    case "reasoning":
      return { kind: "reasoning", text: asString(part.text) ?? "" };
    case "tool-call":
      return {
        kind: "tool-call",
        toolCallId: asString(part.toolCallId),
        toolName: asString(part.toolName) ?? "tool",
        input: part.input ?? part.args,
      };
    case "tool-result":
      return {
        kind: "tool-result",
        toolCallId: asString(part.toolCallId) ?? messageTool?.toolCallId,
        toolName: asString(part.toolName) ?? messageTool?.toolName,
        output: part.output ?? part.result,
      };
    case "image":
    case "file":
      return { kind: "image", mediaType: asString(part.mediaType) };
    default:
      return { kind: "unknown", raw: rawPart };
  }
}

function mapResponseToolCall(rawToolCall: unknown): ZCodeModelTrajectoryContentPart {
  const toolCall = asObject(rawToolCall);
  if (!toolCall) {
    return { kind: "unknown", raw: rawToolCall };
  }
  return {
    kind: "tool-call",
    // 归一化后的 response.toolCalls 形如 {id, name, input}。
    toolCallId: asString(toolCall.id) ?? asString(toolCall.toolCallId),
    toolName: asString(toolCall.name) ?? asString(toolCall.toolName) ?? "tool",
    input: toolCall.input ?? toolCall.args,
  };
}

function mapUsage(value: unknown): ZCodeModelTrajectoryUsage | undefined {
  const usage = asObject(value);
  if (!usage) {
    return undefined;
  }
  return {
    inputTokens: asNumber(usage.inputTokens),
    outputTokens: asNumber(usage.outputTokens),
    totalTokens: asNumber(usage.totalTokens),
    cacheReadTokens: asNumber(usage.cacheReadTokens),
    reasoningTokens: asNumber(usage.reasoningTokens),
  };
}

function tryParseJson(value: string, isError = false): unknown {
  if (isError) return { type: "error-text", value };
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
