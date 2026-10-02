import { useCallback, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { acquireWorkspaceConnection } from "@/v4/workspaceConnectionRegistry.js";
import { logger } from "@/logger.js";
import {
  clearTrackedGeneration,
  generationWorkspaceKey,
  getTrackedGenerationSessionId,
  hasTrackedGeneration,
  trackGeneration,
  type RepoWikiGenerationScope,
} from "./generationRegistry.js";

export type { RepoWikiGenerationScope } from "./generationRegistry.js";

export type RepoWikiGenerationResult =
  | { ok: true; sessionId: string }
  | { ok: false; reasonCode: string };

/**
 * Repo Wiki 生成动作：与对话 composer 解耦，直接经任务运行时发起后台生成任务
 * （spec：repo-wiki-and-file-explorer.md「生成」节）。
 *
 * 单命令通路：`createSession { workspaceId, firstInput: { text } }`——建会话即启动
 * 首条输入（协议既有语义，与 saved-workflow 直接启动同一通路族）。因此失败语义简单：
 * createSession 被拒 = 无会话残留，无需回收；accepted = 生成 turn 已在后台运行，
 * UI 只从 wiki.json 轮询观测进度，本 hook 不持有生成状态（pending 仅为防双击）。
 *
 * 连接经既有注册表按 endpoint + workspaceKey 复用（引用计数租约，用毕立即 release）。
 */
export function useRepoWikiGeneration(services: IServiceAccessor) {
  const [pending, setPending] = useState(false);
  // pending 的同步事实源：防同一帧内重复触发（setPending 异步，单靠 state 挡不住）。
  const pendingRef = useRef(false);

  const start = useCallback(
    async (scope: RepoWikiGenerationScope, prompt: string): Promise<RepoWikiGenerationResult> => {
      if (pendingRef.current) {
        return { ok: false, reasonCode: "generation_in_flight" };
      }
      // 单生成任务互斥（spec v5）：createSession ACK 后到目录骨架落盘前存在一个
      // 无视觉反馈的窗口，pending 挡不住窗口外的重复点击——两个会话并发写同一
      // wiki.json 会互相覆盖。登记表已有本仓库会话时直接拒绝，不发命令。
      if (hasTrackedGeneration(scope)) {
        logger.warn("[repo-wiki] 已有生成会话在跑，拒绝重复发起", {
          workspaceId: generationWorkspaceKey(scope),
        });
        return { ok: false, reasonCode: "generation_in_flight" };
      }
      pendingRef.current = true;
      setPending(true);

      const lease = acquireWorkspaceConnection(
        {
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
          ...(scope.remoteSessionId ? { remoteSessionId: scope.remoteSessionId } : {}),
        },
        services.zcodeAgentService,
      );
      try {
        // workspace 身份 key 沿用 AGENTS.md 规则：identity 优先，否则路径。
        const workspaceId = scope.workspaceIdentity?.trim() || scope.workspacePath;
        const ack = await lease.transport.sendCommand(
          createCommandEnvelope({
            type: "createSession",
            payload: {
              workspaceId,
              firstInput: { text: prompt },
              // 顶栏模型选择：仅在用户显式选择时覆盖，缺省保持 runtime 默认。
              ...(scope.modelSelection ? { config: { modelSelection: scope.modelSelection } } : {}),
            },
            sessionId: null,
          }),
        );
        if (ack.status === "accepted" && ack.result?.type === "createSession") {
          trackGeneration(scope, ack.result.sessionId);
          return { ok: true, sessionId: ack.result.sessionId };
        }
        const reasonCode = ack.reasonCode ?? ack.status;
        logger.warn("[repo-wiki] createSession 被拒", {
          workspaceId,
          status: ack.status,
          reasonCode,
        });
        return { ok: false, reasonCode };
      } catch (error) {
        logger.warn("[repo-wiki] createSession 抛错", {
          workspacePath: scope.workspacePath,
          error: error instanceof Error ? error.message : String(error),
        });
        return { ok: false, reasonCode: "exception" };
      } finally {
        lease.release();
        pendingRef.current = false;
        setPending(false);
      }
    },
    [services],
  );

  /**
   * 停止生成：向登记的会话发 v4 `stop {}`（无前台执行 id 时不做误停防护，
   * 该会话由本功能独占）。已落盘页面保留；登记表随即清除，视图转空闲。
   * 无登记会话时静默返回 false（幂等，例如重挂载后生成已自然结束）。
   */
  const stop = useCallback(
    async (scope: RepoWikiGenerationScope): Promise<boolean> => {
      const sessionId = getTrackedGenerationSessionId(scope);
      if (!sessionId) return false;
      clearTrackedGeneration(scope);
      const lease = acquireWorkspaceConnection(
        {
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
          ...(scope.remoteSessionId ? { remoteSessionId: scope.remoteSessionId } : {}),
        },
        services.zcodeAgentService,
      );
      try {
        const ack = await lease.transport.sendCommand(
          createCommandEnvelope({ type: "stop", payload: {}, sessionId }),
        );
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn("[repo-wiki] stop 被拒", {
            sessionId,
            status: ack.status,
            reasonCode: ack.reasonCode ?? null,
          });
        }
        return true;
      } catch (error) {
        logger.warn("[repo-wiki] stop 抛错", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      } finally {
        lease.release();
      }
    },
    [services],
  );

  return { start, stop, pending };
}
