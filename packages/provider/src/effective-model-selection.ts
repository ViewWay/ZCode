import type { AccountProviderStates } from "./account-provider-state.js";
import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";
export type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";
import {
  validateModelSelectionOptions,
  type ModelSelection,
  type ProviderRegistryView,
} from "./registry.js";
import { isSmartModelSelection, resolveSmartRoute } from "./smart-routing.js";

export type ModelSelectionProviderKind = "ordinary" | "account-plan" | "account-offpeak";
export type ModelSelectionProviderClassifier = (providerId: string) => ModelSelectionProviderKind;

/**
 * 只解析未来执行的意图，不改原选择、持久记录或已固定请求。
 * 原因：读取时清库会让临时失效永久丢失；账号对应也不能退化为同名模型跨任意供应商匹配。
 */
export function resolveEffectiveModelSelection(input: {
  readonly selection: ModelSelection | null;
  readonly registry: ProviderRegistryView;
  readonly accountStates?: AccountProviderStates;
  readonly classifyProvider: ModelSelectionProviderClassifier;
  readonly resolveLegacyReasoningLevel?: (selection: ModelSelection) => string | undefined;
  /**
   * Smart 虚拟选择的改写时机：仅在执行边界（core 回合解析）为 true。
   * 显示/保存路径保持 false——Smart 原意图直达到 core，由套餐感知端口逐回合调度。
   */
  readonly resolveSmartSelection?: boolean;
}): EffectiveModelSelectionResult {
  let original = input.selection;
  if (!original)
    return Object.freeze({ effectiveSelection: null, selectionIssue: "selection-missing" });
  // Smart 虚拟选择：执行边界改写为具体模型；显示/保存路径保持 Smart 原意图。
  if (input.resolveSmartSelection === true && isSmartModelSelection(original)) {
    const routed = resolveSmartRoute(input.registry);
    if (!routed) {
      return Object.freeze({ effectiveSelection: null, selectionIssue: "provider-not-found" });
    }
    original = routed;
  }
  const kind = input.classifyProvider(original.providerId);
  let providerId = original.providerId;
  if (kind === "account-plan") {
    const current = Object.entries(input.accountStates ?? {}).filter(
      ([id, state]) => state.current === true && input.classifyProvider(id) === "account-plan",
    );
    if (current.length !== 1) {
      return Object.freeze({
        effectiveSelection: null,
        selectionIssue: "account-connection-unavailable",
      });
    }
    providerId = current[0]![0];
  }
  const provider = input.registry.providers.find(
    (candidate) => candidate.providerId === providerId,
  );
  if (!provider || (provider.config.visibility === "hidden" && kind !== "account-offpeak")) {
    return Object.freeze({ effectiveSelection: null, selectionIssue: "provider-not-found" });
  }
  const model = provider.models.find((candidate) => candidate.modelId === original.modelId);
  if (!model) return Object.freeze({ effectiveSelection: null, selectionIssue: "model-not-found" });
  let normalized = original;
  let validation = validateModelSelectionOptions(model, normalized);
  if (!validation.ok && validation.code === "reasoning-level-not-supported") {
    const reasoningLevel = input.resolveLegacyReasoningLevel?.({ ...original, providerId });
    if (reasoningLevel !== undefined) {
      const candidate = { ...original, options: { ...original.options, reasoningLevel } };
      const checked = validateModelSelectionOptions(model, candidate);
      if (checked.ok) {
        normalized = candidate;
        validation = checked;
      }
    }
  }
  const selection = Object.freeze({
    providerId,
    modelId: original.modelId,
    ...(validation.ok && normalized.options
      ? { options: Object.freeze({ ...normalized.options }) }
      : {}),
  });
  return Object.freeze({
    effectiveSelection: selection,
    ...(!validation.ok &&
    (validation.code === "reasoning-level-missing" ||
      validation.code === "reasoning-level-not-supported")
      ? { selectionIssue: validation.code }
      : {}),
  });
}
