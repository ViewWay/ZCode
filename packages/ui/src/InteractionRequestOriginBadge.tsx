import type { ZCodeInteractionRequestOrigin } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function InteractionRequestOriginBadge({
  className,
  origin,
}: {
  className?: string;
  origin?: ZCodeInteractionRequestOrigin;
}) {
  const { intl } = useZCodeIntl();
  if (origin?.kind !== "subagent") {
    return null;
  }

  // Agent Teams（specs/agent-teams.md AC4）：teammate 的请求带团队身份，
  // 徽标升级为「队友名 · 团队名」，让 lead/用户能区分请求来自哪位队友。
  if (origin.teamName && origin.teammateName) {
    const teammateTitle = intl.formatMessage(
      { id: "chat.interactionOrigin.teammate.title" },
      { teammateName: origin.teammateName, teamName: origin.teamName },
    );
    return (
      <Badge
        variant="outline"
        title={teammateTitle}
        data-interaction-origin-badge="teammate"
        className={cn("max-w-40 align-baseline text-ui-base truncate", className)}
      >
        {intl.formatMessage({ id: "chat.interactionOrigin.teammate" })}
      </Badge>
    );
  }

  const label = intl.formatMessage({ id: "chat.interactionOrigin.subagent" });
  const title = origin.agentType
    ? intl.formatMessage(
        { id: "chat.interactionOrigin.subagent.title" },
        { agentType: origin.agentType },
      )
    : label;

  return (
    <Badge
      variant="outline"
      title={title}
      data-interaction-origin-badge="subagent"
      className={cn("max-w-40 align-baseline text-ui-base truncate", className)}
    >
      {label}
    </Badge>
  );
}
