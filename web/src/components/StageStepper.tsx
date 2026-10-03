import { Check, Loader2, Minus, X } from "lucide-react";
import { deriveStages } from "../stages";
import type { RunState } from "../types";
import { cn } from "../ui/cn";

export function StageStepper({ run }: { run: Pick<RunState, "status" | "history"> }) {
  const stages = deriveStages(run);
  return (
    <ol aria-label="运行阶段" className="scroll-thin relative m-0 flex list-none items-center gap-0 overflow-x-auto p-0 pb-1">
      {stages.map((stage, index) => (
        <li key={stage.id} aria-current={stage.state === "current" ? "step" : undefined} className="flex shrink-0 items-center">
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={cn(
                "grid size-[18px] place-items-center rounded-full text-on-accent transition-colors",
                stage.state === "done" && "bg-success",
                stage.state === "current" && "bg-accent",
                stage.state === "failed" && "bg-danger",
                (stage.state === "pending" || stage.state === "skipped") && "bg-surface-3 text-muted",
              )}
            >
              {stage.state === "done" && <Check className="size-3" strokeWidth={3} />}
              {stage.state === "current" && <Loader2 className="size-3 motion-safe:animate-spin" strokeWidth={3} />}
              {stage.state === "failed" && <X className="size-3" strokeWidth={3} />}
              {stage.state === "skipped" && <Minus className="size-3" />}
              {stage.state === "pending" && <span className="size-1 rounded-full bg-muted/60" />}
            </span>
            <span
              className={cn(
                "text-xs font-medium whitespace-nowrap",
                stage.state === "current" && "text-ink",
                stage.state === "failed" && "text-danger-ink",
                stage.state === "done" && "text-ink-2",
                (stage.state === "pending" || stage.state === "skipped") && "text-muted",
              )}
            >
              {stage.label}
              <span className="sr-only">
                {stage.state === "done" ? "（已完成）" : stage.state === "current" ? "（进行中）" : stage.state === "failed" ? "（在此停止）" : stage.state === "skipped" ? "（已跳过）" : "（未开始）"}
              </span>
            </span>
          </span>
          {index < stages.length - 1 && (
            <span
              aria-hidden
              className={cn(
                "mx-2.5 h-px w-5 shrink-0 sm:w-8",
                stage.state === "done" || stage.state === "skipped" ? "bg-success/50" : "bg-line-strong",
              )}
            />
          )}
        </li>
      ))}
    </ol>
  );
}
