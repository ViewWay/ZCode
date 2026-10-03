import { AlertTriangleIcon, FolderTreeIcon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  RepoWikiGenerationOptions,
  type RepoWikiGenerationOptionsProps,
} from "./RepoWikiGenerationOptions.js";

/**
 * Repo Wiki 空态：居中的生成配置表单（语言/模型/重试/图表可选）+ 生成入口。
 * spec：未生成时展示居中的可选配置列表，选好再生成。
 * `invalidExistingWiki`（spec v4）：wiki.json 存在但无法解析时提示覆盖风险，
 * 避免用户在不知情时重新生成并覆盖既有 Wiki。
 */
export function RepoWikiEmptyState({
  generateDisabled,
  onGenerate,
  generationOptions,
  invalidExistingWiki = false,
}: {
  generateDisabled: boolean;
  onGenerate: () => void;
  generationOptions: RepoWikiGenerationOptionsProps;
  invalidExistingWiki?: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <div className="flex size-10 items-center justify-center rounded-xl bg-accent">
          <FolderTreeIcon className="size-5 text-foreground" />
        </div>
        <div>
          <p className="text-ui-lg font-semibold text-foreground">
            {intl.formatMessage({ id: "repoWiki.card.title" })}
          </p>
          <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">
            {intl.formatMessage({ id: "repoWiki.card.desc" })}
          </p>
        </div>
        <div className="flex w-full flex-col items-center gap-3 rounded-xl border border-border bg-surface p-4">
          <RepoWikiGenerationOptions {...generationOptions} variant="form" />
          <div className="w-full border-t border-border pt-2.5 text-left">
            <span className="block truncate font-mono text-ui-xs text-foreground-subtlest">
              ~/.zcode/v2/repo-wiki/&lt;workspace-hash&gt;/wiki.json
            </span>
            {invalidExistingWiki ? (
              <span className="mt-1 flex items-start gap-1 text-ui-xs leading-4 text-warning">
                <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
                {intl.formatMessage({ id: "repoWiki.card.invalidJson" })}
              </span>
            ) : null}
          </div>
        </div>
        <Button size="sm" onClick={onGenerate} disabled={generateDisabled}>
          <SparklesIcon className="size-3.5" />
          {intl.formatMessage({ id: "repoWiki.generate" })}
        </Button>
        <p className="text-ui-xs text-foreground-subtlest">
          {intl.formatMessage({ id: "repoWiki.card.generateHint" })}
        </p>
      </div>
    </div>
  );
}
