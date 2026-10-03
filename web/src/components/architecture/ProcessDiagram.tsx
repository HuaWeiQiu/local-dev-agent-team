import { Check, Loader2, Minus, X } from "lucide-react";
import { describeStage } from "../../architecture";
import { deriveStages, type StageId } from "../../stages";
import type { RunEvent, RunState } from "../../types";
import { cn } from "../../ui/cn";

interface ProcessDiagramProps {
  run: RunState;
  events: RunEvent[];
  selectedStageId?: StageId;
  onSelectStage(id: StageId): void;
  /** `strip` stays above the architecture diagram once tasks exist. */
  variant?: "full" | "strip";
}

const STATE_ICON = {
  done: Check,
  current: Loader2,
  failed: X,
  skipped: Minus,
  pending: undefined,
} as const;

/** Clickable process architecture: every pipeline stage is a node you can inspect. */
export function ProcessDiagram({ run, events, selectedStageId, onSelectStage, variant = "full" }: ProcessDiagramProps) {
  const stages = deriveStages(run);
  return (
    <ol
      aria-label="流程架构"
      className={cn(
        "m-0 list-none gap-2 p-0",
        variant === "strip" ? "scroll-thin flex overflow-x-auto" : "grid sm:grid-cols-2 xl:grid-cols-3",
      )}
    >
      {stages.map((stage) => {
        const brief = describeStage(run, stage.id, events);
        const Icon = STATE_ICON[stage.state];
        const selected = selectedStageId === stage.id;
        return (
          <li key={stage.id}>
            <button
              type="button"
              onClick={() => onSelectStage(stage.id)}
              aria-pressed={selected}
              className={cn(
                "flex h-full cursor-pointer flex-col gap-1.5 rounded-lg border border-solid bg-surface p-3 text-left transition-colors hover:bg-surface-2 focus-ring",
                variant === "strip" ? "w-52 shrink-0" : "w-full",
                selected && "border-accent outline-2 outline-offset-2 outline-accent",
                stage.state === "current" && !selected && "border-accent/50",
                stage.state === "failed" && "border-danger/40",
              )}
            >
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={cn(
                    "grid size-5 place-items-center rounded-full text-on-accent",
                    stage.state === "done" && "bg-success",
                    stage.state === "current" && "bg-accent",
                    stage.state === "failed" && "bg-danger",
                    (stage.state === "pending" || stage.state === "skipped") && "bg-surface-3 text-muted",
                  )}
                >
                  {Icon ? (
                    <Icon className={cn("size-3", stage.state === "current" && "motion-safe:animate-spin")} strokeWidth={3} />
                  ) : (
                    <span className="size-1 rounded-full bg-muted/70" />
                  )}
                </span>
                <strong className="text-sm font-semibold text-ink">{stage.label}</strong>
              </span>
              <span className="line-clamp-2 text-xs leading-relaxed text-ink-2">{brief.headline}</span>
              {brief.liveText && (
                <span className="line-clamp-2 font-mono text-2xs leading-relaxed text-muted">{brief.liveText}</span>
              )}
              <span className="text-2xs text-muted">点击查看这一步</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
