import { runStatusLabel, statusTone, taskStatusLabel } from "../presentation";
import type { RunStatus, TaskStatus } from "../types";
import { Badge } from "./badge";
import { cn } from "./cn";

export type StatusToneName = "neutral" | "active" | "success" | "warning" | "danger" | "info";

const dotColor: Record<StatusToneName, string> = {
  neutral: "bg-muted/60",
  active: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
};

export function normalizeTone(tone: string): StatusToneName {
  return tone in dotColor ? (tone as StatusToneName) : "neutral";
}

/** A status colour dot. `pulse` is used for in-flight work and is disabled by prefers-reduced-motion. */
export function StatusDot({ tone, pulse = false, className }: { tone: StatusToneName; pulse?: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn("relative inline-flex size-2 shrink-0", className)}>
      {pulse ? (
        <span className={cn("absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping", dotColor[tone])} />
      ) : null}
      <span className={cn("relative size-2 rounded-full", dotColor[tone])} />
    </span>
  );
}

export function RunStatusPill({ status }: { status: RunStatus }) {
  const tone = normalizeTone(statusTone(status));
  return (
    <Badge tone={tone}>
      <StatusDot tone={tone} pulse={tone === "active"} className="size-1.5" />
      {runStatusLabel(status)}
    </Badge>
  );
}

export function TaskStatusPill({ status }: { status: TaskStatus }) {
  const tone = normalizeTone(statusTone(status));
  return (
    <Badge tone={tone}>
      <StatusDot tone={tone} pulse={tone === "active"} className="size-1.5" />
      {taskStatusLabel(status)}
    </Badge>
  );
}
