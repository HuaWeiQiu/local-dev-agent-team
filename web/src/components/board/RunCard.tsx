import { Clock, Trash2 } from "lucide-react";
import type { BoardCard } from "../../board";
import { formatRelative } from "../../time";
import { Badge } from "../../ui/badge";
import { cn } from "../../ui/cn";
import { RunStatusPill } from "../../ui/status";
import {
  badgeFor,
  barTone,
  goalLabel,
  progressPercent,
  railClass,
  strategyLabel,
  visibleFailure,
} from "./card-model";

const BAR_CLASS = { danger: "bg-danger", accent: "bg-accent" } as const;

export function RunCard({
  card,
  selected,
  busy,
  deletable,
  onOpen,
  onDelete,
}: {
  card: BoardCard;
  selected: boolean;
  busy: boolean;
  deletable: boolean;
  onOpen(): void;
  onDelete(): void;
}) {
  return (
    <article className={cn("group relative border-l-[3px] bg-surface pr-8", railClass(card), selected && "bg-accent-soft/40")}>
      <button
        type="button"
        onClick={onOpen}
        className="block w-full cursor-pointer border-0 bg-transparent px-3 py-2.5 text-left focus-ring"
        aria-label={`打开运行：${goalLabel(card.run.goal, 80)}`}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:grid sm:grid-cols-[minmax(0,1fr)_5.5rem_4.5rem_5.25rem_7.5rem]">
          <h4 className="m-0 min-w-0 truncate text-sm font-medium text-ink" title={card.run.goal}>
            {goalLabel(card.run.goal)}
          </h4>
          <StatusCell card={card} />
          <span className="truncate text-2xs text-muted">{strategyLabel(card)}</span>
          <span className="flex items-center justify-end gap-1 text-2xs text-muted">
            <Clock className="size-3 shrink-0" />
            {formatRelative(card.run.updatedAt)}
          </span>
          <ProgressCell card={card} />
        </div>
        <FailureLine card={card} />
      </button>
      {deletable && <DeleteButton busy={busy} onDelete={onDelete} />}
    </article>
  );
}

function StatusCell({ card }: { card: BoardCard }) {
  const badge = badgeFor(card);
  if (!badge) {
    return (
      <span className="justify-self-start">
        <RunStatusPill status={card.run.status} />
      </span>
    );
  }
  return (
    <span className="justify-self-start">
      <Badge tone={badge.tone === "neutral" ? "neutral" : (badge.tone as never)}>{badge.label}</Badge>
    </span>
  );
}

function ProgressCell({ card }: { card: BoardCard }) {
  const { done, total } = card.progress;
  if (total === 0) return <span />;
  return (
    <span className="flex items-center gap-2">
      <span
        role="progressbar"
        aria-label="任务进度"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={`${done}/${total} 个任务`}
        className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3"
      >
        <span
          className={cn("block h-full rounded-full", BAR_CLASS[barTone(card)])}
          style={{ width: `${progressPercent(card)}%` }}
        />
      </span>
      <span className="w-7 text-right text-2xs tabular-nums text-muted">
        {done}/{total}
      </span>
    </span>
  );
}

function FailureLine({ card }: { card: BoardCard }) {
  const failure = visibleFailure(card);
  if (!failure) return null;
  return <p className="m-0 mt-1 line-clamp-1 text-xs text-danger-ink">{failure}</p>;
}

function DeleteButton({ busy, onDelete }: { busy: boolean; onDelete(): void }) {
  return (
    <button
      type="button"
      disabled={busy}
      aria-label="删除运行"
      title="删除运行"
      onClick={onDelete}
      className="absolute right-2 top-2 grid size-6 cursor-pointer place-items-center rounded-md border-0 bg-surface-2 text-muted opacity-0 transition-opacity hover:text-danger-ink focus-visible:opacity-100 group-hover:opacity-100 focus-ring"
    >
      <Trash2 className="size-3.5" />
    </button>
  );
}
