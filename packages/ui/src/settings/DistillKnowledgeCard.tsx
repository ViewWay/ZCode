/* 已沉淀知识审阅列表（specs/auto-distill.md）：
   会话结束触发器提取的候选在此审阅：确认 → 写入来源工作区的项目记忆（后续会话可召回）；
   提升 → 用户技能目录生成 SKILL.md 草稿（不自动启用）；删除 → 只弃用候选。
   数据走 IDistillKnowledgeService（Desktop 本地 Host 提供）；服务缺失（远端/Web host）
   时整块隐藏。candidates.json 损坏时错误原因经 store 的稳定中文信息透出。 */
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { DistillCandidate } from "@zcode/shared";
import type { ConfirmedMemoryEffect } from "@zcode/services";
import type { IDistillKnowledgeService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { cn } from "@/components/lib/utils.js";
import { AutomationTrashIcon } from "@/settings/AutomationDesignPrimitives.js";
import { formatDateTime } from "@/settings/automationFormat.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatCreatedAt(candidate: DistillCandidate): string {
  const ts = Date.parse(candidate.createdAt);
  return Number.isFinite(ts) ? formatDateTime(ts) : "-";
}

/** 规则置信度 0~1 → 整数百分比；v1 规则式上限 0.9（仍需人工审阅）。 */
function formatConfidence(candidate: DistillCandidate): string {
  return `${Math.round(candidate.confidence * 100)}%`;
}

function kindLabelKey(candidate: DistillCandidate): string {
  return candidate.kind === "repeated-command"
    ? "distillKnowledge.kindRepeated"
    : "distillKnowledge.kindAdoptedFix";
}

export function DistillKnowledgeCard({
  distillKnowledgeService,
}: {
  distillKnowledgeService: IDistillKnowledgeService | undefined;
}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const [candidates, setCandidates] = useState<DistillCandidate[]>([]);
  const [confirmed, setConfirmed] = useState<ConfirmedMemoryEffect[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!distillKnowledgeService) return;
    setLoading(true);
    try {
      setCandidates(await distillKnowledgeService.list());
      // 已确认记忆的效果视图（delta 惰性计算）；失败不阻塞候选列表。
      setConfirmed(await distillKnowledgeService.listConfirmedWithEffect().catch(() => []));
      setError(null);
    } catch (listError) {
      // candidates.json 损坏等失败态：store 的错误信息已含可读原因，原样透出。
      const message = toMessage(listError);
      logger.error("[distillKnowledge] 加载沉淀候选失败", message);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [distillKnowledgeService]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 服务缺失（远端/Web host）时整块隐藏，不渲染空壳。
  if (!distillKnowledgeService) return null;

  const handleConfirm = async (candidate: DistillCandidate) => {
    if (busyId) return;
    setBusyId(candidate.id);
    setError(null);
    try {
      const outcome = await distillKnowledgeService.confirm(candidate.id);
      if (outcome.status === "missing") {
        // 重复确认（另一窗口已处理）：按幂等成功收口并刷新列表。
        toast(intl.formatMessage({ id: "distillKnowledge.confirmMissing" }));
      } else {
        toast(intl.formatMessage({ id: "distillKnowledge.confirmDone" }));
      }
      await refresh();
    } catch (confirmError) {
      const message = toMessage(confirmError);
      logger.error("[distillKnowledge] 确认候选失败", { candidateId: candidate.id, message });
      toast(intl.formatMessage({ id: "distillKnowledge.confirmFailed" }, { message }));
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const handlePromote = async (candidate: DistillCandidate) => {
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "distillKnowledge.promoteConfirmTitle" }),
      description: intl.formatMessage({ id: "distillKnowledge.promoteConfirmDescription" }),
      confirmLabel: intl.formatMessage({ id: "distillKnowledge.promote" }),
    });
    if (!confirmed) return;
    setBusyId(candidate.id);
    setError(null);
    try {
      const promoted = await distillKnowledgeService.promote(candidate.id);
      if (promoted) {
        toast(
          intl.formatMessage(
            { id: "distillKnowledge.promoteDone" },
            { path: promoted.skillFilePath },
          ),
        );
      } else {
        toast(intl.formatMessage({ id: "distillKnowledge.confirmMissing" }));
      }
      await refresh();
    } catch (promoteError) {
      const message = toMessage(promoteError);
      logger.error("[distillKnowledge] 提升技能草稿失败", { candidateId: candidate.id, message });
      toast(intl.formatMessage({ id: "distillKnowledge.promoteFailed" }, { message }));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (candidate: DistillCandidate) => {
    const confirmed = await confirmDialog({
      title: intl.formatMessage(
        { id: "distillKnowledge.deleteConfirmTitle" },
        { summary: candidate.summary },
      ),
      description: intl.formatMessage({ id: "distillKnowledge.deleteConfirmDescription" }),
      confirmLabel: intl.formatMessage({ id: "common.delete" }),
    });
    if (!confirmed) return;
    setBusyId(candidate.id);
    try {
      await distillKnowledgeService.delete(candidate.id);
      await refresh();
    } catch (deleteError) {
      const message = toMessage(deleteError);
      logger.error("[distillKnowledge] 删除候选失败", { candidateId: candidate.id, message });
      toast(intl.formatMessage({ id: "distillKnowledge.deleteFailed" }, { message }));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="flex w-full flex-col gap-4" data-distill-knowledge>
      <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
        {intl.formatMessage({ id: "distillKnowledge.sectionTitle" })}
      </h2>
      {error ? (
        <div className="rounded-xl border border-card-border bg-background p-3 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "distillKnowledge.loadFailed" }, { error })}
        </div>
      ) : null}
      {loading && candidates.length === 0 ? (
        <div className="flex items-center gap-2 p-3 text-ui-base text-foreground-subtle">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {intl.formatMessage({ id: "common.loading" })}
        </div>
      ) : candidates.length === 0 ? (
        <div className="rounded-xl border border-card-border bg-background p-3 text-center text-ui-base font-normal text-foreground-subtlest">
          {intl.formatMessage({ id: "distillKnowledge.empty" })}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {candidates.map((candidate) => {
            const busy = busyId === candidate.id;
            return (
              <li
                key={candidate.id}
                className={cn(
                  "flex min-w-0 items-center gap-3 rounded-xl border border-card-border bg-background p-3",
                  busy && "opacity-70",
                )}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="truncate text-ui-base font-medium leading-5 text-foreground"
                      title={candidate.summary}
                    >
                      {candidate.summary}
                    </span>
                    {/* 类别徽章：候选来自哪条规则（高频命令 / 被采纳修复）。 */}
                    <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
                      {intl.formatMessage({ id: kindLabelKey(candidate) })}
                    </span>
                    {/* 置信度：审阅列表排序依据，直接展示给用户判断。 */}
                    <span className="shrink-0 font-mono text-ui-xs leading-none text-foreground-subtlest">
                      {formatConfidence(candidate)}
                    </span>
                  </div>
                  <span className="truncate text-ui-base font-normal leading-5 text-foreground-subtle">
                    {intl.formatMessage(
                      { id: "distillKnowledge.meta" },
                      {
                        sessionId: candidate.sourceSessionId,
                        createdAt: formatCreatedAt(candidate),
                      },
                    )}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-1"
                  disabled={busyId !== null}
                  onClick={() => void handleConfirm(candidate)}
                >
                  {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                  {intl.formatMessage({ id: "distillKnowledge.confirm" })}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-1"
                  disabled={busyId !== null}
                  onClick={() => void handlePromote(candidate)}
                >
                  {intl.formatMessage({ id: "distillKnowledge.promote" })}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  disabled={busyId !== null}
                  aria-label={intl.formatMessage({ id: "common.delete" })}
                  onClick={() => void handleDelete(candidate)}
                >
                  <AutomationTrashIcon />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {confirmed.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-ui-sm font-medium leading-5 text-foreground-subtle">
            {intl.formatMessage({ id: "distillKnowledge.confirmedTitle" })}
          </h3>
          <ul className="flex flex-col gap-2">
            {confirmed.map((memory) => {
              const delta = memory.delta;
              const worsening = (delta?.toolErrorsDelta ?? 0) > 0;
              return (
                <li
                  key={memory.file}
                  className="flex min-w-0 items-center gap-3 rounded-xl border border-card-border bg-background p-3"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-ui-base font-medium leading-5 text-foreground">
                        {memory.summary}
                      </span>
                      {worsening ? (
                        <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
                          {intl.formatMessage({ id: "distillKnowledge.retireBadge" })}
                        </span>
                      ) : null}
                    </div>
                    <span className="truncate text-ui-xs leading-4 text-foreground-subtlest">
                      {delta
                        ? intl.formatMessage(
                            { id: "distillKnowledge.effectLine" },
                            {
                              errors: String(delta.toolErrorsDelta),
                              sessions: String(delta.sessions),
                            },
                          )
                        : intl.formatMessage({ id: "distillKnowledge.effectPending" })}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() =>
                      void distillKnowledgeService
                        .archiveConfirmed(memory.file)
                        .then(() => refresh())
                        .catch((archiveError) => {
                          logger.error("[distillKnowledge] 归档失败", toMessage(archiveError));
                        })
                    }
                  >
                    {intl.formatMessage({ id: "distillKnowledge.archive" })}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
