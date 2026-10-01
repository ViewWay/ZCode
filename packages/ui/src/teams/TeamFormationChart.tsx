// 团队协作面板·编队拓扑(v2.10):lead 居中、成员横排、SVG 连线。
// 成员行展示颜色标记、名字与活跃状态,状态行拼接当前执行任务短编号。
// 只读展示,不修改任何事实源。

import type { TeamRoster, TeamTaskProjection } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const SLOT_W = 84;
const VIEW_H = 128;
const VIEW_MIN_W = 320;

/** SVG circle 的 fill 属性不能用 tailwind bg-* 类,映射为与 bg-*-500 等价的 hex 字面量。 */
const TEAM_COLOR_HEX: Record<string, string> = {
  red: "#ef4444",
  blue: "#3b82f6",
  green: "#22c55e",
  yellow: "#eab308",
  purple: "#a855f7",
  orange: "#f97316",
  pink: "#ec4899",
  cyan: "#06b6d4",
};

export function TeamFormationChart({ team, tasks }: { team: TeamRoster; tasks: TeamTaskProjection[] }) {
  const { intl } = useZCodeIntl();
  if (!team || team.members.length === 0) {
    return null;
  }

  const lead = team.members.find((member) => member.agentId === team.leadAgentId);
  const others = team.members.filter((member) => member !== lead);

  // 纯 SVG + viewBox 等比缩放,适配侧栏窄容器(同 TaskDependencyGraph)。
  const viewW = Math.max(VIEW_MIN_W, others.length * SLOT_W);
  const memberX = (index: number) => viewW / 2 + (index - (others.length - 1) / 2) * SLOT_W;

  return (
    <svg viewBox={`0 0 ${viewW} ${VIEW_H}`} width="100%" role="img">
      {lead ? (
        <g>
          <circle cx={viewW / 2} cy={24} r={12} className="fill-card stroke-border" />
          <text x={viewW / 2} y={48} textAnchor="middle" className="fill-foreground text-[10px]">
            {lead.name.slice(0, 10)}
          </text>
        </g>
      ) : null}
      {others.map((member, index) => {
        const x = memberX(index);
        const current = tasks.find((task) => task.owner === member.name && task.status === "in_progress");
        const taskSuffix = current ? ` · #${current.taskId.replace(/^task_/, "").slice(0, 6)}` : "";
        return (
          <g key={member.agentId}>
            {lead ? (
              <line x1={viewW / 2} y1={36} x2={x} y2={84} strokeWidth={1} className="stroke-border" />
            ) : null}
            <circle cx={x} cy={92} r={4} fill={TEAM_COLOR_HEX[member.color ?? ""] ?? "#94a3b8"} />
            <text x={x} y={106} textAnchor="middle" className="fill-foreground text-[9px]">
              {member.name.slice(0, 8)}
            </text>
            <text
              x={x}
              y={118}
              textAnchor="middle"
              className={member.isActive ? "fill-green-600 text-[9px]" : "fill-foreground-subtle text-[9px]"}
            >
              {intl.formatMessage({ id: member.isActive ? "chat.teams.active" : "chat.teams.idle" })}
              {taskSuffix}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
