// ============================================================
// Smart v2 套餐额度路由 - 协议端口（策略面）
// ============================================================
// Smart 虚拟选择（smart/auto）的 v2 决策实现，跑在协议 server 进程内：
// 1. 只考虑已登录且连接 Coding Plan 的账号套餐 provider（未登录/未连接一律跳过）。
// 2. 剩余额度 ≥ 5%（SMART_ROUTING_LOW_QUOTA_THRESHOLD）直接选该套餐的最大上下文窗口模型。
// 3. 剩余 < 5% 且存在未过期重置卡时，自动核销最早过期的卡（与手动「重置」按钮同一
//    useCodingPlanReset 调用面），恢复到阈值以上即选中该套餐；核销失败不阻塞，降级为无卡路径。
// 4. 套餐全部不可用时回落 v1 目录择优（resolveSmartRoute，语义与解析期 v1 完全一致）；
//    连目录都为空时返回 unavailable，调用方走既有 provider-not-found 路径。
// 额度与重置卡事实经 server→client 协议请求向宿主索取（off-peak 端口同款通道），
// 宿主用 IUsageStatsService 兑现；任何查询失败都只影响该候选（跳过），不抛错阻断 turn。
// 闲时（off-peak）套餐：services 侧暂无闲时时间窗能力，v2 先按 account-offpeak 类
// provider 的可用性优先排序（可用即排在前），时间窗判定待后续接入。

import type { SmartRoutingDecision, SmartRoutingPort } from "@zcode/contracts";
import type { ZCodeProviderAccountAccess } from "@zcode/shared";
import {
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  zcodeProtocolMethods,
  zcodeSmartRoutingResetStatusResultSchema,
  zcodeSmartRoutingUsageSnapshotResultSchema,
  zcodeSmartRoutingUseResetResultSchema,
} from "@zcode/shared";
import {
  resolveSmartRoute,
  type ProviderRegistryServiceSnapshot,
  type ProviderRegistryView,
} from "@zcode/provider";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/** 剩余额度低于该占比视为套餐即将耗尽，触发重置卡/切换候选。 */
export const SMART_ROUTING_LOW_QUOTA_THRESHOLD = 0.05;

/** 宿主侧额度/重置卡查询的单次超时；超时按该候选查询失败处理（跳过，不重试）。 */
const SMART_ROUTING_REQUEST_TIMEOUT_MS = 10_000;

export interface SmartRoutingPlanSnapshot {
  state: "authenticated" | "not_authenticated" | "unavailable";
  /** 剩余额度占比（0~1）；null 表示已认证但拿不到百分比。 */
  remainingPercentage: number | null;
}

export interface SmartRoutingResetCard {
  resetType: "FIVE_HOUR" | "WEEK";
  expireAt: number;
}

/**
 * 套餐额度数据面：宿主实现（协议 RPC 代理）与测试 fake 共用的窄接口。
 * 结构上对应 IUsageStatsService 的 entitlement/reset 三个调用，但只保留路由所需字段。
 */
export interface SmartRoutingUsageStats {
  getPlanUsageSnapshot(
    providerId: string,
    accountAccess?: ZCodeProviderAccountAccess,
  ): Promise<SmartRoutingPlanSnapshot>;
  getResetCards(
    providerId: string,
    accountAccess?: ZCodeProviderAccountAccess,
  ): Promise<SmartRoutingResetCard[]>;
  useResetCard(input: {
    providerId: string;
    accountAccess?: ZCodeProviderAccountAccess;
    idempotencyKey: string;
    resetType: "FIVE_HOUR" | "WEEK";
  }): Promise<{ used: boolean }>;
}

export interface SmartRoutingCatalogEntry {
  providerId: string;
  kind: "account-plan" | "account-offpeak" | "ordinary";
  /** 已登录且连接该套餐（account-plan 看 states.current；off-peak 看 availability）。 */
  usable: boolean;
  models: readonly { modelId: string; contextWindow: number }[];
  accountAccess?: ZCodeProviderAccountAccess;
}

/** 从 Registry 快照投影路由目录：账号状态（登录/连接事实）与 provider 静态访问类别同源。 */
export function buildSmartRoutingCatalog(
  snapshot: ProviderRegistryServiceSnapshot,
): readonly SmartRoutingCatalogEntry[] {
  return snapshot.registry.providers
    .filter(
      (provider) =>
        provider.config.visibility !== "hidden" ||
        provider.config.access?.type === "zhipu-account",
    )
    .map((provider) => {
      const access = provider.config.access;
      const state = snapshot.account.states?.[provider.providerId];
      const kind =
        access?.type === "zhipu-account"
          ? access.mode === "off-peak"
            ? ("account-offpeak" as const)
            : access.mode === "individual-coding-plan" || access.mode === "team-coding-plan"
              ? ("account-plan" as const)
              : ("ordinary" as const)
          : ("ordinary" as const);
      // account-plan 与 effective-model-selection 同一把尺（current + 非 unavailable）；
      // off-peak 不定义 current，按可用性判定。
      const usable =
        kind === "account-plan"
          ? state?.current === true && state.availability !== "unavailable"
          : kind === "account-offpeak"
            ? state?.availability === "available"
            : false;
      return {
        providerId: provider.providerId,
        kind,
        usable,
        models: provider.models.map((model) => ({
          modelId: model.modelId,
          contextWindow:
            typeof model.config.properties?.contextWindow === "number"
              ? model.config.properties.contextWindow
              : 0,
        })),
        ...(access?.type === "zhipu-account" && kind !== "ordinary"
          ? {
              accountAccess: {
                type: "zhipu-account" as const,
                accountType:
                  access.accountType ??
                  (provider.providerId === ZAI_PROVIDER_ID ? ("zai" as const) : ("bigmodel" as const)),
                mode: access.mode,
                entitled: true,
              },
            }
          : {}),
      };
    });
}

export function createSmartRoutingPort(input: {
  usageStats: SmartRoutingUsageStats;
  /** 每次决策重读的目录快照（Registry 实时投影）。 */
  getCatalog(): readonly SmartRoutingCatalogEntry[];
  /** v1 目录择优的原始 Registry 视图；读取失败时端口只能给 unavailable。 */
  getRegistryView(): ProviderRegistryView | undefined;
  now?(): number;
}): SmartRoutingPort {
  const now = input.now ?? Date.now;
  return {
    async getRoutingDecision(taskInput?: { taskPreview?: string }): Promise<SmartRoutingDecision> {
      const tier = classifyTaskTier(taskInput?.taskPreview);
      const skipped: string[] = [];
      let catalog: readonly SmartRoutingCatalogEntry[] = [];
      try {
        catalog = input.getCatalog();
      } catch {
        catalog = [];
      }
      const accountCandidates = catalog.filter(
        (entry) =>
          (entry.kind === "account-plan" || entry.kind === "account-offpeak") &&
          entry.usable &&
          entry.models.length > 0,
      );
      // 闲时套餐可用即优先（时间窗能力接入前的近似）；组内保持目录顺序。
      const ordered = [
        ...accountCandidates.filter((entry) => entry.kind === "account-offpeak"),
        ...accountCandidates.filter((entry) => entry.kind === "account-plan"),
      ];
      // 第一阶段：预取全部候选的额度快照（服务端有缓存，逐候选双查询代价可控）。
      const evaluated: {
        candidate: SmartRoutingCatalogEntry;
        snapshot?: SmartRoutingPlanSnapshot;
        queryError?: string;
      }[] = [];
      for (const candidate of ordered) {
        try {
          evaluated.push({
            candidate,
            snapshot: await input.usageStats.getPlanUsageSnapshot(
              candidate.providerId,
              candidate.accountAccess,
            ),
          });
        } catch (error) {
          evaluated.push({ candidate, queryError: errorMessage(error) });
        }
      }
      // flash 档：有 Flash 模型的已认证候选里取剩余最高（免费轨通常满额，天然优先消耗）。
      if (tier === "flash") {
        let best: { candidate: SmartRoutingCatalogEntry; percentage: number } | undefined;
        for (const entry of evaluated) {
          const flashSnapshot = entry.snapshot;
          if (
            !flashSnapshot ||
            flashSnapshot.state !== "authenticated" ||
            flashSnapshot.remainingPercentage === null
          ) {
            continue;
          }
          if (flashSnapshot.remainingPercentage < SMART_ROUTING_LOW_QUOTA_THRESHOLD) continue;
          const flash = flashModelOf(entry.candidate);
          if (!flash) continue;
          if (best === undefined || flashSnapshot.remainingPercentage > best.percentage) {
            best = { candidate: entry.candidate, percentage: flashSnapshot.remainingPercentage };
          }
        }
        if (best) {
          const flash = flashModelOf(best.candidate)!;
          const percent = Math.round(best.percentage * 1000) / 10;
          return {
            kind: "plan",
            providerId: best.candidate.providerId,
            modelId: flash.modelId,
            tier,
            note: `Smart flash 档：任务简单，优先消耗剩余最高的轨（${best.candidate.providerId}/${flash.modelId}，剩余 ${percent}%）`,
          };
        }
      }

      // pro 档（或 flash 档无可用 Flash 模型的回退）：first-fit + 低额度自动用卡。
      for (const entry of evaluated) {
        const candidate = entry.candidate;
        const label = `${candidate.providerId}/${pickModel(candidate, tier)}`;
        const snapshot = entry.snapshot;
        if (entry.queryError !== undefined) {
          skipped.push(`${label}（额度查询失败：${entry.queryError}）`);
          continue;
        }
        if (!snapshot || snapshot.state !== "authenticated") {
          skipped.push(`${label}（${snapshot?.state === "not_authenticated" ? "未登录" : "暂不可用"}）`);
          continue;
        }
        if (snapshot.remainingPercentage === null) {
          skipped.push(`${label}（剩余额度未知）`);
          continue;
        }
        const percent = Math.round(snapshot.remainingPercentage * 1000) / 10;
        if (snapshot.remainingPercentage >= SMART_ROUTING_LOW_QUOTA_THRESHOLD) {
          return {
            kind: "plan",
            providerId: candidate.providerId,
            tier,
            modelId: pickModel(candidate, tier),
            note: `Smart 已选套餐 ${label}：剩余额度 ${percent}%（阈值 5%）${
              candidate.kind === "account-offpeak" ? "，闲时套餐可用优先" : ""
            }${tier === "flash" ? "（flash 档无 Flash 模型，回退主力模型）" : ""}`,
          };
        }
        // 低额度：先用最早过期的重置卡（核销失败不阻塞，降级为无卡路径）。
        const resetOutcome = await tryUseEarliestResetCard(input.usageStats, candidate, now);
        if (resetOutcome.recovered) {
          const afterPercent = Math.round(resetOutcome.remainingPercentage! * 1000) / 10;
          return {
            kind: "plan",
            providerId: candidate.providerId,
            tier,
            modelId: pickModel(candidate, tier),
            note: `Smart 已选套餐 ${label}：剩余 ${percent}% 低于阈值，已自动使用最早过期的重置卡（${resetOutcome.resetType}），恢复到 ${afterPercent}%`,
          };
        }
        skipped.push(`${label}（剩余 ${percent}% 低于阈值${resetOutcome.reason ? `，${resetOutcome.reason}` : ""}）`);
      }
      // 套餐耗尽/未登录：回落 v1 目录择优（与解析期 v1 同一函数，语义完全一致）。
      const routed = safeResolveSmartRoute(input.getRegistryView);
      if (routed) {
        return {
          kind: "catalog",
          providerId: routed.providerId,
          modelId: routed.modelId,
          note:
            skipped.length > 0
              ? `Smart 套餐不可用（${skipped.join("；")}），回落普通目录择优 ${routed.providerId}/${routed.modelId}`
              : `Smart 无已登录套餐，回落普通目录择优 ${routed.providerId}/${routed.modelId}`,
        };
      }
      return {
        kind: "unavailable",
        note:
          skipped.length > 0
            ? `Smart 套餐不可用且目录择优无候选（${skipped.join("；")}）`
            : "Smart 无已登录套餐且目录为空",
      };
    },
  };
}

/** provider 内模型择优：pro 档取上下文窗口最大者；flash 档优先 modelId 含 flash（大小写不敏感）者，无则回退最大者。 */
function pickModel(candidate: SmartRoutingCatalogEntry, tier: "pro" | "flash"): string {
  if (tier === "flash") {
    const flash = flashModelOf(candidate);
    if (flash) {
      return flash.modelId;
    }
  }
  let best = candidate.models[0]!;
  for (const model of candidate.models) {
    if (model.contextWindow > best.contextWindow) best = model;
  }
  return best.modelId;
}

/** flash 档模型：modelId 含 flash（大小写不敏感）者中上下文最大；无则 undefined。 */
function flashModelOf(candidate: SmartRoutingCatalogEntry): {
  modelId: string;
  contextWindow: number;
} | undefined {
  const flash = candidate.models.filter((model) => /flash/i.test(model.modelId));
  if (flash.length === 0) return undefined;
  return flash.reduce((best, model) => (model.contextWindow > best.contextWindow ? model : best));
}

/** 任务档位启发式：复杂→pro（主力模型），简单→flash（免费轨/Flash 优先消耗）。 */
function classifyTaskTier(taskPreview?: string): "pro" | "flash" {
  const text = (taskPreview ?? "").trim();
  if (text.length === 0) return "pro";
  if (text.length > 2000) return "pro";
  if ((text.match(/```/g) ?? []).length >= 2) return "pro";
  if (
    /(实现|重构|架构|迁移|排查|调试|调研|设计|优化|性能|安全|实现类|refactor|architect|migrat|debug|design|optimize|security)/i.test(
      text,
    )
  ) {
    return "pro";
  }
  return "flash";
}

async function tryUseEarliestResetCard(
  usageStats: SmartRoutingUsageStats,
  candidate: SmartRoutingCatalogEntry,
  now: () => number,
): Promise<{
  recovered: boolean;
  remainingPercentage?: number;
  resetType?: "FIVE_HOUR" | "WEEK";
  reason?: string;
}> {
  let cards: SmartRoutingResetCard[] = [];
  try {
    cards = await usageStats.getResetCards(candidate.providerId, candidate.accountAccess);
  } catch (error) {
    return { recovered: false, reason: `重置卡查询失败：${errorMessage(error)}` };
  }
  const card = cards
    .filter((item) => item.expireAt > now())
    .sort((left, right) => left.expireAt - right.expireAt)[0];
  if (!card) return { recovered: false, reason: "无未过期重置卡" };
  try {
    const used = await usageStats.useResetCard({
      providerId: candidate.providerId,
      ...(candidate.accountAccess ? { accountAccess: candidate.accountAccess } : {}),
      idempotencyKey: `smart-routing:${crypto.randomUUID()}`,
      resetType: card.resetType,
    });
    if (!used.used) return { recovered: false, reason: `重置卡核销未生效（${card.resetType}）` };
  } catch (error) {
    return { recovered: false, reason: `重置卡核销失败：${errorMessage(error)}` };
  }
  // 核销已受理：重新读一次额度，恢复到阈值以上才确认选中该套餐。
  try {
    const after = await usageStats.getPlanUsageSnapshot(
      candidate.providerId,
      candidate.accountAccess,
    );
    if (
      after.state === "authenticated" &&
      after.remainingPercentage !== null &&
      after.remainingPercentage >= SMART_ROUTING_LOW_QUOTA_THRESHOLD
    ) {
      return {
        recovered: true,
        remainingPercentage: after.remainingPercentage,
        resetType: card.resetType,
      };
    }
    return { recovered: false, reason: "重置后额度仍未达阈值" };
  } catch (error) {
    return { recovered: false, reason: `重置后额度确认失败：${errorMessage(error)}` };
  }
}

function safeResolveSmartRoute(
  getRegistryView: () => ProviderRegistryView | undefined,
): { providerId: string; modelId: string } | undefined {
  try {
    const registryView = getRegistryView();
    return registryView ? resolveSmartRoute(registryView) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 经 server→client 协议请求向宿主索取额度/重置卡事实（off-peak 端口同款通道）。
 * requestContext 延迟解析：协议 server 构造完成后才可回填（officialMcpAuthRequestContext 同款收口）。
 */
export function createProtocolSmartRoutingUsageStats(
  resolveRequestContext: () => Pick<ZCodeProtocolAgentServerContext, "requestClient">,
): SmartRoutingUsageStats {
  return {
    async getPlanUsageSnapshot(providerId, accountAccess) {
      const result = await resolveRequestContext().requestClient(
        zcodeProtocolMethods.smartRoutingUsageSnapshot,
        { providerId, ...(accountAccess ? { accountAccess } : {}) },
        zcodeSmartRoutingUsageSnapshotResultSchema,
        { timeoutMs: SMART_ROUTING_REQUEST_TIMEOUT_MS },
      );
      return { state: result.state, remainingPercentage: result.remainingPercentage };
    },
    async getResetCards(providerId, accountAccess) {
      const result = await resolveRequestContext().requestClient(
        zcodeProtocolMethods.smartRoutingResetStatus,
        { providerId, ...(accountAccess ? { accountAccess } : {}) },
        zcodeSmartRoutingResetStatusResultSchema,
        { timeoutMs: SMART_ROUTING_REQUEST_TIMEOUT_MS },
      );
      return result.cards;
    },
    async useResetCard(resetInput) {
      const result = await resolveRequestContext().requestClient(
        zcodeProtocolMethods.smartRoutingUseReset,
        {
          providerId: resetInput.providerId,
          idempotencyKey: resetInput.idempotencyKey,
          resetType: resetInput.resetType,
          ...(resetInput.accountAccess ? { accountAccess: resetInput.accountAccess } : {}),
        },
        zcodeSmartRoutingUseResetResultSchema,
        { timeoutMs: SMART_ROUTING_REQUEST_TIMEOUT_MS },
      );
      return { used: result.used };
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
