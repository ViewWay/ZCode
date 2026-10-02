import { useMemo, useState } from "react";
import type { ModelSelection } from "@zcode/shared";
import { useModelSelectionView } from "@/hooks/useModelSelectionView.js";
import {
  parseModelSelectValue,
  type RepoWikiGenerationOptionsProps,
  type RepoWikiModelOption,
} from "./RepoWikiGenerationOptions.js";

/**
 * 生成选项状态（spec：视图态，不持久化）：语言 / 模型 / 重试次数 / 生成图表。
 * 顶栏（bar）与空态居中表单（form）共用同一份受控状态（generationOptions）。
 * locale 仅作为语言选项的初值（跟随界面语言）。
 */
export function useRepoWikiGenerationOptions(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  locale: "zh-CN" | "en-US";
}): {
  generationOptions: RepoWikiGenerationOptionsProps;
  wikiLanguage: "zh-CN" | "en-US";
  modelOverride: ModelSelection | null;
  /** 供生成提示词使用的当前选项值。 */
  retryPerPage: number;
  generateDiagrams: boolean;
} {
  const { workspacePath, workspaceIdentity, workspaceRemoteSessionId, locale } = params;
  const [wikiLanguage, setWikiLanguage] = useState<"zh-CN" | "en-US">(locale);
  const [generateDiagrams, setGenerateDiagrams] = useState(true);
  const [retryPerPage, setRetryPerPage] = useState(0);
  const [modelOverride, setModelOverride] = useState<ModelSelection | null>(null);
  const modelSelectionRead = useModelSelectionView(
    workspacePath,
    workspaceRemoteSessionId ?? null,
    workspaceIdentity ?? null,
  );
  const modelOptions = useMemo<RepoWikiModelOption[]>(() => {
    if (modelSelectionRead.state.status !== "ready") return [];
    return modelSelectionRead.state.view.providers.map((provider) => ({
      providerId: provider.providerId,
      providerLabel: provider.providerName ?? provider.providerId,
      models: provider.models.map((model) => ({
        value: `${provider.providerId}/${model.modelId}`,
        modelId: model.modelId,
      })),
    }));
  }, [modelSelectionRead.state]);
  const preferredSelection =
    modelSelectionRead.state.status === "ready"
      ? (modelSelectionRead.state.view.preferredSelection ?? null)
      : null;
  const selectedModel = modelOverride ?? preferredSelection;
  const selectedModelValue = selectedModel
    ? `${selectedModel.providerId}/${selectedModel.modelId}`
    : "default";
  const generationOptions: RepoWikiGenerationOptionsProps = {
    language: wikiLanguage,
    onLanguageChange: setWikiLanguage,
    modelOptions,
    selectedModelValue,
    onModelValueChange: (value) => setModelOverride(parseModelSelectValue(value)),
    retryPerPage,
    onRetryPerPageChange: setRetryPerPage,
    generateDiagrams,
    onGenerateDiagramsChange: setGenerateDiagrams,
  };
  return { generationOptions, wikiLanguage, modelOverride, retryPerPage, generateDiagrams };
}
