import { zcodeWorkspaceUpdateSessionChatPreferencesParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 应用会话互聊（实验）工具面开关（与 updateModelIoPreferences 同款独立方法）。
 * 开关写入进程级 appRuntimePreferences，只影响之后创建/恢复的会话——端口在
 * runtime 装配时注入，已在运行的会话保持装配时的工具面（与 offPeakToolEnabled
 * 生命周期语义一致）。
 */
export async function updateSessionChatPreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateSessionChatPreferencesParamsSchema, rawParams);
  const enabled = params.preferences.sessionChatEnabled;
  context.appRuntimePreferences.sessionChatEnabled = enabled;
  return {
    workspace: params.workspace,
    sessionChatEnabled: enabled,
  };
}
