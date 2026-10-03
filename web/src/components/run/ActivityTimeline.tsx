import { formatTimestamp } from "../../presentation";
import { timelineKindLabels, type TimelineEntry, type TimelineKind } from "../../timeline";
import { cn } from "../../ui/cn";
import { StatusDot, normalizeTone } from "../../ui/status";
import { EmptyState } from "../EmptyState";

interface ActivityTimelineProps {
  hasRun: boolean;
  entries: TimelineEntry[];
  visible: TimelineEntry[];
  kinds: ReadonlySet<TimelineKind>;
  kindCounts: Record<TimelineKind, number>;
  onKindsChange(kinds: ReadonlySet<TimelineKind>): void;
}

export function ActivityTimeline({ hasRun, entries, visible, kinds, kindCounts, onKindsChange }: ActivityTimelineProps) {
  return (
    <div className="flex flex-col">
      {hasRun && entries.length > 0 && (
        <div role="group" aria-label="活动类型筛选" className="bd-b sticky top-0 z-10 flex flex-wrap gap-1.5 bg-surface px-4 py-2.5 md:px-6">
          <FilterChip pressed={kinds.size === 0} count={entries.length} onClick={() => onKindsChange(new Set())}>全部</FilterChip>
          {(Object.keys(timelineKindLabels) as TimelineKind[])
            .filter((kind) => kindCounts[kind] > 0)
            .map((kind) => (
              <FilterChip key={kind} pressed={kinds.has(kind)} count={kindCounts[kind]} onClick={() => onKindsChange(toggleKind(kinds, kind))}>
                {timelineKindLabels[kind]}
              </FilterChip>
            ))}
        </div>
      )}
      {visible.length > 0 && (
        <ol className="bd-l m-0 ml-[26px] mr-4 mt-4 list-none p-0 md:ml-[34px] md:mr-6">
          {visible.map((entry) => (
            <li key={entry.key} className="relative pb-4 pl-4 last:pb-2">
              <StatusDot tone={normalizeTone(entry.tone)} className="absolute -left-[5px] top-[7px] rounded-full ring-4 ring-surface" />
              <div className="flex items-baseline gap-2">
                <strong className="min-w-0 break-words text-sm font-medium text-ink">{entry.title}</strong>
                <time className="ml-auto shrink-0 text-2xs tabular-nums text-muted" dateTime={entry.at}>{formatTimestamp(entry.at)}</time>
              </div>
              {entry.detail && <p className="m-0 mt-0.5 break-words text-xs leading-relaxed text-muted">{entry.detail}</p>}
            </li>
          ))}
        </ol>
      )}
      {!hasRun && <EmptyState size="inline" title="选择运行后显示活动" />}
      {hasRun && entries.length === 0 && <EmptyState size="inline" title="还没有活动记录" />}
    </div>
  );
}

function FilterChip({ pressed, count, onClick, children }: { pressed: boolean; count: number; onClick(): void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "group inline-flex h-6 cursor-pointer items-center rounded-full px-2.5 transition-colors focus-ring",
        pressed ? "border border-solid border-accent-line bg-accent-soft" : "bd bg-transparent hover:bg-surface-3",
      )}
    >
      <span className={cn("inline-flex items-center gap-1.5 text-2xs font-medium", pressed ? "text-accent-ink" : "text-muted group-hover:text-ink")}>
        {children}
        <span className="tabular-nums opacity-70">{count}</span>
      </span>
    </button>
  );
}

function toggleKind(current: ReadonlySet<TimelineKind>, kind: TimelineKind): ReadonlySet<TimelineKind> {
  const next = new Set(current);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  return next;
}
