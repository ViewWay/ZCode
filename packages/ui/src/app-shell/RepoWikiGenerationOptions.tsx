import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import type { ModelSelection } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface RepoWikiModelOption {
  providerId: string;
  providerLabel: string;
  models: Array<{ value: string; modelId: string }>;
}

export interface RepoWikiGenerationOptionsProps {
  language: "zh-CN" | "en-US";
  onLanguageChange: (language: "zh-CN" | "en-US") => void;
  modelOptions: RepoWikiModelOption[];
  selectedModelValue: string;
  onModelValueChange: (value: string) => void;
  retryPerPage: number;
  onRetryPerPageChange: (retry: number) => void;
  generateDiagrams: boolean;
  onGenerateDiagramsChange: (value: boolean) => void;
  /**
   * bar：顶栏横向一排（已完成态）；form：空态居中表单，逐行带标签
   * （spec：未生成时展示居中的可选配置列表）。
   */
  variant?: "bar" | "form";
}

/**
 * 生成选项（受控组件，状态归 workbench——spec：视图态，不持久化）：
 * 语言 / 模型 / 重试次数 / 生成图表。
 */
export function RepoWikiGenerationOptions(props: RepoWikiGenerationOptionsProps) {
  const { intl } = useZCodeIntl();
  const {
    language,
    onLanguageChange,
    modelOptions,
    selectedModelValue,
    onModelValueChange,
    retryPerPage,
    onRetryPerPageChange,
    generateDiagrams,
    onGenerateDiagramsChange,
    variant = "bar",
  } = props;

  const languageSelect = (
    <Select
      value={language}
      onValueChange={(value) => onLanguageChange(value === "en-US" ? "en-US" : "zh-CN")}
    >
      <SelectTrigger className={variant === "form" ? "h-7 w-full text-ui-xs" : "h-7 w-[112px] text-ui-xs"}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="zh-CN">{intl.formatMessage({ id: "repoWiki.language.zhCN" })}</SelectItem>
        <SelectItem value="en-US">{intl.formatMessage({ id: "repoWiki.language.enUS" })}</SelectItem>
      </SelectContent>
    </Select>
  );

  const modelSelect = (
    <Select value={selectedModelValue} onValueChange={onModelValueChange}>
      <SelectTrigger className={variant === "form" ? "h-7 w-full text-ui-xs" : "h-7 w-[150px] text-ui-xs"}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">
          {intl.formatMessage({ id: "repoWiki.model.default" })}
        </SelectItem>
        {modelOptions.map((provider) => (
          <SelectGroup key={provider.providerId}>
            <SelectLabel>{provider.providerLabel}</SelectLabel>
            {provider.models.map((model) => (
              <SelectItem key={model.value} value={model.value}>
                {model.modelId}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );

  const retrySelect = (
    <Select
      value={String(retryPerPage)}
      onValueChange={(value) => onRetryPerPageChange(Number(value) || 0)}
    >
      <SelectTrigger
        className={variant === "form" ? "h-7 w-full text-ui-xs" : "h-7 w-[104px] text-ui-xs"}
        title={intl.formatMessage({ id: "repoWiki.retry.hint" })}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {[0, 1, 2, 3].map((retry) => (
          <SelectItem key={retry} value={String(retry)}>
            {intl.formatMessage({ id: "repoWiki.retry" }, { count: retry })}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const diagramsSwitch = (
    <label className="flex items-center gap-1.5 text-ui-xs text-foreground-subtle">
      <Switch
        checked={generateDiagrams}
        onCheckedChange={(checked) => onGenerateDiagramsChange(checked === true)}
      />
      {intl.formatMessage({ id: "repoWiki.diagrams" })}
    </label>
  );

  if (variant === "form") {
    const rowClass = "flex w-full items-center justify-between gap-3";
    const labelClass = "shrink-0 text-ui-sm text-foreground-subtle";
    return (
      <div className="flex w-full flex-col gap-2.5">
        <div className={rowClass}>
          <span className={labelClass}>{intl.formatMessage({ id: "repoWiki.card.language" })}</span>
          <div className="w-[180px]">{languageSelect}</div>
        </div>
        <div className={rowClass}>
          <span className={labelClass}>{intl.formatMessage({ id: "repoWiki.card.model" })}</span>
          <div className="w-[180px]">{modelSelect}</div>
        </div>
        <div className={rowClass}>
          <span className={labelClass}>{intl.formatMessage({ id: "repoWiki.retryCountLabel" })}</span>
          <div className="w-[180px]">{retrySelect}</div>
        </div>
        <div className={rowClass}>
          <span className={labelClass}>{intl.formatMessage({ id: "repoWiki.diagrams" })}</span>
          {diagramsSwitch}
        </div>
      </div>
    );
  }

  return (
    <>
      {languageSelect}
      {modelSelect}
      {retrySelect}
      {diagramsSwitch}
    </>
  );
}

/** 供 workbench 解析模型 Select 值；"default" 返回 null（不覆盖会话模型）。 */
export function parseModelSelectValue(value: string): ModelSelection | null {
  if (value === "default") return null;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return null;
  return { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) };
}
