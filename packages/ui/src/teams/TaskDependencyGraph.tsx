// 团队协作面板·任务依赖 DAG(v2.10):按 blockedBy 拓扑分层,每层一行卡片。
// 连线语义:前驱 completed = 实线(已满足,流向下游);否则虚线(未满足)。
// 阻塞任务(依赖未全 completed)以半透明 + 锁标展示,不可认领。
// 纯 SVG(viewBox 等比缩放)适配侧栏窄容器;只读展示,不修改任何事实源。

import { useMemo } from "react";
import type { TeamTaskProjection } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const CARD_W = 150;
const CARD_H = 48;
const H_GAP = 12;
const ROW_GAP = 26;
const MARGIN = 8;
const VIEW_MIN_W = 320;
const SUBJECT_MAX_CHARS = 16;

interface GraphNode {
  task: TeamTaskProjection;
  x: number;
  y: number;
}

interface GraphEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  satisfied: boolean;
}

export function TaskDependencyGraph({ tasks }: { tasks: TeamTaskProjection[] }) {
  const { intl } = useZCodeIntl();

  const { nodes, edges, viewW, viewH } = useMemo(() => {
    const byId = new Map(tasks.map((task) => [task.taskId, task]));
    const depthCache = new Map<string, number>();
    const visiting = new Set<string>();

    // 深度 = 1 + 最深前驱;visiting 兜环检测(runtime 状态机不允许环,防御性保护渲染不悬挂)。
    const depthOf = (id: string): number => {
      const cached = depthCache.get(id);
      if (cached !== undefined) return cached;
      const task = byId.get(id);
      if (!task) return 0;
      const deps = (task.blockedBy ?? []).filter((dep) => byId.has(dep));
      if (deps.length === 0) {
        depthCache.set(id, 0);
        return 0;
      }
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const depth = 1 + Math.max(...deps.map(depthOf));
      visiting.delete(id);
      depthCache.set(id, depth);
      return depth;
    };

    const layers = new Map<number, TeamTaskProjection[]>();
    for (const task of tasks) {
      const depth = depthOf(task.taskId);
      const layer = layers.get(depth);
      if (layer) {
        layer.push(task);
      } else {
        layers.set(depth, [task]);
      }
    }
    const depths = [...layers.keys()].sort((a, b) => a - b);

    let maxRowWidth = 0;
    for (const depth of depths) {
      const row = layers.get(depth);
      if (!row) continue;
      maxRowWidth = Math.max(maxRowWidth, row.length * CARD_W + (row.length - 1) * H_GAP);
    }
    const viewW = Math.max(VIEW_MIN_W, maxRowWidth + 2 * MARGIN);

    const nodeMap = new Map<string, GraphNode>();
    for (const depth of depths) {
      const row = layers.get(depth);
      if (!row) continue;
      const rowWidth = row.length * CARD_W + (row.length - 1) * H_GAP;
      const y = depth * (CARD_H + ROW_GAP);
      let x = (viewW - rowWidth) / 2;
      for (const task of row) {
        nodeMap.set(task.taskId, { task, x, y });
        x += CARD_W + H_GAP;
      }
    }

    const edges: GraphEdge[] = [];
    for (const task of tasks) {
      const node = nodeMap.get(task.taskId);
      if (!node) continue;
      for (const dep of task.blockedBy ?? []) {
        const depNode = nodeMap.get(dep);
        if (!depNode) continue;
        edges.push({
          x1: depNode.x + CARD_W / 2,
          y1: depNode.y + CARD_H,
          x2: node.x + CARD_W / 2,
          y2: node.y,
          satisfied: depNode.task.status === "completed",
        });
      }
    }

    const viewH = depths.length * (CARD_H + ROW_GAP);
    return { nodes: [...nodeMap.values()], edges, viewW, viewH };
  }, [tasks]);

  if (tasks.length === 0) {
    return (
      <p className="px-1 text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "chat.teams.dashboard.noTasks" })}
      </p>
    );
  }

  const completedIds = new Set(tasks.filter((task) => task.status === "completed").map((task) => task.taskId));
  const shortId = (taskId: string) => `#${taskId.replace(/^task_/, "").slice(0, 6)}`;
  const statusOf = (task: TeamTaskProjection): { label: string; blocked: boolean; unlocked: boolean } => {
    const unmetDeps = (task.blockedBy ?? []).some((id) => !completedIds.has(id));
    const blocked = task.status !== "completed" && task.status !== "cancelled" && unmetDeps;
    const unlocked = task.status === "pending" && !unmetDeps && (task.blockedBy ?? []).length > 0;
    const label = blocked
      ? intl.formatMessage({ id: "chat.zcode.teams.blocked" })
      : intl.formatMessage({
          id:
            task.status === "completed"
              ? "chat.teams.dashboard.done"
              : task.status === "in_progress"
                ? "chat.teams.dashboard.inProgress"
                : "chat.teams.dashboard.pending",
        });
    return { label, blocked, unlocked };
  };

  return (
    <div className="min-w-0 space-y-1">
      <svg viewBox={`0 0 ${viewW} ${viewH}`} width="100%" role="img">
        {edges.map((edge, index) => (
          <line
            key={`edge-${index}`}
            x1={edge.x1}
            y1={edge.y1}
            x2={edge.x2}
            y2={edge.y2}
            strokeWidth={1.5}
            strokeDasharray={edge.satisfied ? undefined : "4 3"}
            className={edge.satisfied ? "stroke-green-600" : "stroke-amber-500"}
          />
        ))}
        {nodes.map((node) => {
          const { label, blocked, unlocked } = statusOf(node.task);
          const subject = node.task.subject;
          const shownSubject =
            subject.length > SUBJECT_MAX_CHARS ? `${subject.slice(0, SUBJECT_MAX_CHARS - 1)}…` : subject;
          const running = node.task.status === "in_progress";
          return (
            <g key={node.task.taskId} opacity={blocked ? 0.6 : 1}>
              <rect
                x={node.x}
                y={node.y}
                width={CARD_W}
                height={CARD_H}
                rx={6}
                strokeWidth={running || unlocked ? 1.5 : 1}
                className={
                  running ? "fill-card stroke-green-600" : unlocked ? "fill-card stroke-amber-500" : "fill-card stroke-border"
                }
              />
              <text x={node.x + 8} y={node.y + 14} className="fill-foreground-subtle text-[9px]">
                {shortId(node.task.taskId)}
              </text>
              <text
                x={node.x + CARD_W - 8}
                y={node.y + 14}
                textAnchor="end"
                className="fill-foreground-subtle text-[9px]"
              >
                {blocked ? `🔒${label}` : node.task.status === "completed" ? `✓${label}` : running ? `⏳${label}` : `⏸${label}`}
              </text>
              <text x={node.x + 8} y={node.y + 28} className="fill-foreground text-[10px]">
                {shownSubject}
              </text>
              {node.task.owner ? (
                <text x={node.x + 8} y={node.y + 40} className="fill-foreground-subtle text-[9px]">
                  @{node.task.owner}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
        <span className="flex items-center gap-1 text-ui-xs text-foreground-subtle">
          <svg width="18" height="6" aria-hidden>
            <line x1="0" y1="3" x2="18" y2="3" strokeWidth="1.5" strokeDasharray="4 3" className="stroke-amber-500" />
          </svg>
          {intl.formatMessage({ id: "chat.teams.dashboard.legendBlocked" })}
        </span>
        <span className="flex items-center gap-1 text-ui-xs text-foreground-subtle">
          <svg width="18" height="6" aria-hidden>
            <line x1="0" y1="3" x2="18" y2="3" strokeWidth="1.5" className="stroke-green-600" />
          </svg>
          {intl.formatMessage({ id: "chat.teams.dashboard.legendSatisfied" })}
        </span>
        <span className="text-ui-xs text-foreground-subtle">
          ⏳ {intl.formatMessage({ id: "chat.teams.dashboard.legendRunning" })}
        </span>
        <span className="text-ui-xs text-foreground-subtle">
          ✨ {intl.formatMessage({ id: "chat.teams.dashboard.legendUnlocked" })}
        </span>
      </div>
    </div>
  );
}
