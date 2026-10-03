import { useMemo } from "react";
import {
  ARCHITECTURE_KIND_LABEL,
  ARCHITECTURE_RELATION_LABEL,
  ARCHITECTURE_SOURCE_LABEL,
  presentArchitecture,
  type ModuleStatus,
} from "../../architecture";
import type { ArchitectureDesign, TaskRunState } from "../../types";
import { cn } from "../../ui/cn";

interface ArchitectureDiagramProps {
  tasks: TaskRunState[];
  design?: ArchitectureDesign;
  selectedModuleId?: string;
  onSelectModule(id: string): void;
}

const STATUS_LABEL: Record<ModuleStatus, string> = {
  working: "进行中",
  blocked: "被阻塞",
  done: "已完成",
  pending: "未开始",
  mixed: "部分完成",
};

const STATUS_DOT: Record<ModuleStatus, string> = {
  working: "bg-accent",
  blocked: "bg-danger",
  done: "bg-success",
  pending: "bg-muted/50",
  mixed: "bg-warning",
};

const SOURCE_HINT = {
  architect: "架构师给出的系统设计。点一个元素，看职责、上下游和正在做的任务。",
  controller: "目标已经写明路径，控制面直接生成了这份结构。",
  inferred: "这次运行没有架构设计。下面按任务路径推断，不是架构师的产出。",
} as const;

/** System map and main-flow sequence. Both are views of the same design. */
export function ArchitectureDiagram({ tasks, design, selectedModuleId, onSelectModule }: ArchitectureDiagramProps) {
  const presentation = useMemo(() => presentArchitecture(tasks, design), [tasks, design]);
  const diagram = presentation.diagram;
  if (diagram.boxes.length === 0) return null;
  const boxOf = new Map(diagram.boxes.map((box) => [box.id, box]));
  const nameOf = (id: string) => boxOf.get(id)?.label ?? id;
  return (
    <section aria-label="系统架构图" className="bd-b bg-surface px-4 py-3 md:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 text-xs font-medium text-ink-2">系统架构</h3>
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-2xs text-muted">{ARCHITECTURE_SOURCE_LABEL[presentation.source]}</span>
      </div>
      {presentation.summary && <p className="m-0 mt-1 text-xs text-ink-2">{presentation.summary}</p>}
      <p className="m-0 mt-1 mb-3 text-xs text-muted">{SOURCE_HINT[presentation.source]}</p>
      <div className="scroll-thin overflow-x-auto">
        <div className="relative" style={{ width: diagram.width, height: diagram.height }}>
          <svg aria-hidden className="pointer-events-none absolute inset-0" width={diagram.width} height={diagram.height}>
            <defs>
              <marker id="arch-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" fill="var(--muted)" />
              </marker>
            </defs>
            {diagram.edges.map((edge) => {
              const from = boxOf.get(edge.from);
              const to = boxOf.get(edge.to);
              if (!from || !to) return null;
              const x1 = from.x + from.width / 2;
              const y1 = from.y + from.height;
              const x2 = to.x + to.width / 2;
              const y2 = to.y;
              const mid = (y1 + y2) / 2;
              const caption = edge.label ?? (edge.kind ? ARCHITECTURE_RELATION_LABEL[edge.kind] : undefined);
              return (
                <g key={`${edge.from}-${edge.to}-${edge.kind ?? "link"}`}>
                  <path
                    d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2 - 2}`}
                    fill="none"
                    stroke="var(--muted)"
                    strokeWidth={1.5}
                    markerEnd="url(#arch-arrow)"
                  />
                  {caption && (
                    <text x={(x1 + x2) / 2} y={mid - 4} textAnchor="middle" fill="var(--muted)" fontSize={10}>
                      {caption}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {diagram.boxes.map((box) => {
            const selected = selectedModuleId === box.id;
            return (
              <button
                key={box.id}
                type="button"
                onClick={() => onSelectModule(box.id)}
                aria-pressed={selected}
                className={cn(
                  "absolute flex cursor-pointer flex-col items-start gap-1 rounded-lg border border-solid bg-surface-2 px-3 py-2 text-left hover:bg-surface focus-ring",
                  selected && "border-accent outline-2 outline-offset-2 outline-accent",
                  box.status === "blocked" && "border-danger/40",
                  box.status === "working" && "border-accent/50",
                )}
                style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
              >
                <span className="flex w-full items-center gap-1.5">
                  <span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[box.status])} />
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{box.label}</span>
                </span>
                <span className="text-2xs text-muted">
                  {box.kind ? `${ARCHITECTURE_KIND_LABEL[box.kind]} · ` : ""}
                  {STATUS_LABEL[box.status]} · {box.tasks.length} 个任务
                </span>
                <span className="text-2xs text-accent-ink">点击查看</span>
              </button>
            );
          })}
        </div>
      </div>
      {presentation.sequence.length > 0 && (
        <div className="mt-4">
          <h4 className="m-0 text-xs font-medium text-ink-2">主流程</h4>
          <ol className="scroll-thin m-0 mt-2 flex list-none gap-2 overflow-x-auto p-0">
            {presentation.sequence.map((step) => (
              <li key={`${step.order}-${step.from}-${step.to}`}>
                <button
                  type="button"
                  onClick={() => onSelectModule(step.to)}
                  className="flex h-full w-56 cursor-pointer flex-col items-start gap-1 rounded-lg border border-solid border-line bg-surface-2 px-3 py-2 text-left hover:bg-surface focus-ring"
                >
                  <span className="text-2xs text-muted">第 {step.order} 步</span>
                  <span className="text-xs text-ink">
                    {nameOf(step.from)} → {nameOf(step.to)}
                  </span>
                  <span className="text-2xs text-ink-2">{step.action}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
