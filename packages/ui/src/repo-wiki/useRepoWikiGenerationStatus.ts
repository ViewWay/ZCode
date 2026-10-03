import { useEffect, useRef } from "react";
import type { WikiGenerationProgress } from "./analysis.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  clearTrackedGeneration,
  hasTrackedGeneration,
  type RepoWikiGenerationScope,
} from "./generationRegistry.js";

export interface UseRepoWikiGenerationStatusParams {
  /** workbench 的 wiki.phase（resolving | missing | ready）。 */
  wikiPhase: "resolving" | "missing" | "ready";
  /** summarizeWikiGeneration 的磁盘推导进度。 */
  progress: WikiGenerationProgress | null;
  /** 用户点过「停止」后本轮不再视为生成中。 */
  userStoppedGeneration: boolean;
  /** useRepoWikiGeneration 的 pending（hook 本地防双击态）。 */
  generationPending: boolean;
  scope: RepoWikiGenerationScope;
}

/**
 * 生成状态机（磁盘推导 + 登记表近似；spec「生成状态机」v3 修订）：
 * - 有「生成中」标记页（generatingPageId 非 null）= 仍有页面在生成；
 * - 仅剩失败标记页视为已结束，否则失败收尾后视图会永远卡在生成中，只能手动停止逃离；
 * - 分析阶段（phase 非 ready）沿用登记表近似（wiki.json 尚未落盘，磁盘无从推导）。
 *
 * 附带两件收尾工作：磁盘显示无页面正在生成时清除登记条目（幂等，防止残留登记把
 * 「删除 Wiki 后的空态」误判为「正在分析代码库」）；自然完成（非用户停止）且视图
 * 经历「生成中 → 空闲」跳变时 toast 通知一次（重挂载不补发）。
 */
export function useRepoWikiGenerationStatus(params: UseRepoWikiGenerationStatusParams): {
  generating: boolean;
  /** 登记表 + pending 的「生成会话在跑」近似：禁用生成/重新生成按钮（spec v5 互斥）。 */
  generationBusy: boolean;
} {
  const { wikiPhase, progress, userStoppedGeneration, generationPending, scope } = params;
  const { intl } = useZCodeIntl();
  // 登记表是模块级 Map（非响应式）：依赖轮询导致的重渲染来重读，与 workbench 既有行为一致。
  const tracked = hasTrackedGeneration(scope);
  // 双推导语义边界（v7 固定）：busy = 登记表 + pending——ACK 后目录骨架落盘前的窗口里
  // generating 可能仍为 false，按钮禁用以 busy 为准；generating = 磁盘 + 登记表 +
  // userStopped，驱动视图态（进度条/停止按钮）。
  const generationBusy = generationPending || tracked;

  const { workspacePath, workspaceIdentity, remoteSessionId } = scope;
  const wasGeneratingRef = useRef(false);
  // 两个分支都必须含 tracked：分析阶段（doc 未就绪）磁盘无从推导，登记表是唯一近似；
  // 已有文档时以「生成中」标记页为准（仅剩失败标记页 = 无页面在生成 → 空闲）。
  const generating =
    !userStoppedGeneration &&
    (progress !== null
      ? tracked && progress.generatingPageId !== null
      : wikiPhase !== "ready" && tracked);
  useEffect(() => {
    const wasGenerating = wasGeneratingRef.current;
    wasGeneratingRef.current = generating;
    if (generating) return;
    if (wikiPhase === "ready" && tracked) {
      clearTrackedGeneration({ workspacePath, workspaceIdentity, remoteSessionId });
    }
    if (wasGenerating && !userStoppedGeneration && wikiPhase === "ready") {
      const failedCount = progress?.failed ?? 0;
      toast(
        intl.formatMessage(
          {
            id:
              failedCount > 0
                ? "repoWiki.generationCompletedWithFailures"
                : "repoWiki.generationCompleted",
          },
          failedCount > 0 ? { count: failedCount } : undefined,
        ),
      );
    }
  }, [
    generating,
    intl,
    progress,
    remoteSessionId,
    tracked,
    userStoppedGeneration,
    wikiPhase,
    workspaceIdentity,
    workspacePath,
  ]);

  return { generating, generationBusy };
}
