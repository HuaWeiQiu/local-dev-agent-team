import { Check, Loader2, Minus, X } from "lucide-react";
import type { StageId, StageState } from "../stages";
import { deriveStages } from "../stages";
import type { RunState } from "../types";
import { cn } from "../ui/cn";
import { isBehind, stageTone } from "./stage-stepper/tone";

interface StageStepperProps {
  run: Pick<RunState, "status" | "history">;
  selectedStageId?: StageId;
  onSelectStage?(id: StageId): void;
}

export function StageStepper({ run, selectedStageId, onSelectStage }: StageStepperProps) {
  const stages = deriveStages(run);
  return (
    <ol aria-label="运行阶段" className="scroll-thin relative m-0 flex list-none items-center gap-0 overflow-x-auto p-0 pb-1">
      {stages.map((stage, index) => (
        <li key={stage.id} aria-current={stage.state === "current" ? "step" : undefined} className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={() => onSelectStage?.(stage.id)}
            aria-pressed={selectedStageId === stage.id}
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-1 py-0.5 focus-ring",
              selectedStageId === stage.id && "bg-accent-soft",
            )}
          >
            <StageDot state={stage.state} />
            <span className={cn("text-xs font-medium whitespace-nowrap", stageTone(stage.state).text)}>
              {stage.label}
              <span className="sr-only">{stageTone(stage.state).spoken}，点击查看</span>
            </span>
          </button>
          {index < stages.length - 1 && <StageConnector state={stage.state} />}
        </li>
      ))}
    </ol>
  );
}

/** The state's own mark: a tick, a spinner, a cross, a dash, or a small dot. */
function StageDot({ state }: { state: StageState }) {
  return (
    <span
      aria-hidden
      className={cn("grid size-[18px] place-items-center rounded-full text-on-accent transition-colors", stageTone(state).dot)}
    >
      {markFor(state)}
    </span>
  );
}

function markFor(state: StageState) {
  switch (state) {
    case "done":
      return <Check className="size-3" strokeWidth={3} />;
    case "current":
      return <Loader2 className="size-3 motion-safe:animate-spin" strokeWidth={3} />;
    case "failed":
      return <X className="size-3" strokeWidth={3} />;
    case "skipped":
      return <Minus className="size-3" />;
    case "pending":
      return <span className="size-1 rounded-full bg-muted/60" />;
  }
}

/** The line to the next stage: green once this one is behind us. */
function StageConnector({ state }: { state: StageState }) {
  return (
    <span
      aria-hidden
      className={cn("mx-2.5 h-px w-5 shrink-0 sm:w-8", isBehind(state) ? "bg-success/50" : "bg-line-strong")}
    />
  );
}
