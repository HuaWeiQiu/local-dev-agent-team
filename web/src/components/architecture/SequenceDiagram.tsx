import type { ArchitectureStep } from "../../types";

interface SequenceDiagramProps {
  steps: ArchitectureStep[];
  nameOf(id: string): string;
  onSelect(id: string): void;
}

const COLUMN = 180;
const HEAD = 36;
const ROW = 72;
const PAD = 24;

/** Lifelines and ordered messages. The steps stay data; this is only a view. */
export function SequenceDiagram({ steps, nameOf, onSelect }: SequenceDiagramProps) {
  const participants: string[] = [];
  for (const step of steps) {
    if (!participants.includes(step.from)) participants.push(step.from);
    if (!participants.includes(step.to)) participants.push(step.to);
  }
  if (participants.length === 0) {
    return <p className="m-0 text-xs text-muted">这份设计没有单独的主流程。</p>;
  }
  const xOf = (id: string) => PAD + participants.indexOf(id) * COLUMN + COLUMN / 2;
  const width = PAD * 2 + participants.length * COLUMN;
  const height = PAD + HEAD + 20 + Math.max(steps.length, 1) * ROW + 16;
  const lineTop = PAD + HEAD;
  const lineBottom = height - 12;
  return (
    <div className="scroll-thin overflow-x-auto" aria-label="时序">
      <div className="relative" style={{ width, height }}>
        <svg aria-hidden className="absolute inset-0" width={width} height={height}>
          <defs>
            <marker id="seq-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="var(--muted)" />
            </marker>
          </defs>
          {participants.map((id) => (
            <line
              key={`line-${id}`}
              x1={xOf(id)}
              x2={xOf(id)}
              y1={lineTop}
              y2={lineBottom}
              stroke="var(--line)"
              strokeDasharray="4 4"
            />
          ))}
          {steps.map((step, index) => {
            const y = lineTop + 28 + index * ROW;
            const x1 = xOf(step.from);
            const x2 = xOf(step.to);
            const self = step.from === step.to;
            return (
              <g key={`${step.order}-${step.from}-${step.to}`}>
                {self ? (
                  <path
                    d={`M ${x1} ${y} C ${x1 + 36} ${y - 16}, ${x1 + 36} ${y + 16}, ${x1} ${y + 4}`}
                    fill="none"
                    stroke="var(--muted)"
                    markerEnd="url(#seq-arrow)"
                  />
                ) : (
                  <line x1={x1} y1={y} x2={x2 + (x2 > x1 ? -6 : 6)} y2={y} stroke="var(--muted)" markerEnd="url(#seq-arrow)" />
                )}
              </g>
            );
          })}
        </svg>
        {participants.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            className="absolute cursor-pointer truncate rounded-md border border-solid border-line bg-surface-2 px-2 py-1 text-center text-xs font-semibold text-ink hover:bg-surface focus-ring"
            style={{ left: xOf(id) - 64, top: PAD, width: 128 }}
          >
            {nameOf(id)}
          </button>
        ))}
        {steps.map((step, index) => {
          const y = lineTop + 28 + index * ROW;
          const x1 = xOf(step.from);
          const x2 = xOf(step.to);
          const center = step.from === step.to ? x1 + 28 : (x1 + x2) / 2;
          return (
            <button
              key={`hit-${step.order}-${step.from}-${step.to}`}
              type="button"
              aria-label={`第 ${step.order} 步 ${nameOf(step.from)} 到 ${nameOf(step.to)}：${step.action}`}
              onClick={() => onSelect(step.to)}
              title={step.action}
              className="absolute max-w-40 -translate-x-1/2 -translate-y-full cursor-pointer truncate rounded-full border border-solid border-line bg-surface px-2 py-0.5 text-2xs text-ink hover:bg-surface-2 focus-ring"
              style={{ left: center, top: y - 6 }}
            >
              {step.order}. {step.action}
            </button>
          );
        })}
      </div>
    </div>
  );
}
