import { useMemo } from "react";
import { deriveTimeline } from "../timeline";
import type { ExplainLine, RunEvent, RunState, TaskRunState } from "../types";
import {
  FailureBanner,
  HeadlineCard,
  PlanCard,
  SummaryAside,
  TaskTable,
} from "./run/overview/sections";

interface RunOverviewProps {
  run: RunState | undefined;
  events: RunEvent[];
  /** One-line, evidence-backed answer to "why is the run in this state". */
  headline?: ExplainLine | undefined;
  onSelectTask(task: TaskRunState): void;
  onOpenActivity(): void;
  onOpenArchitecture?(): void;
}

/** Overview pane: what the run concluded, what its tasks did, and how it looked. */
export function RunOverview({
  run,
  events,
  headline,
  onSelectTask,
  onOpenActivity,
  onOpenArchitecture,
}: RunOverviewProps) {
  const timeline = useMemo(() => deriveTimeline(run, events).slice(-8).reverse(), [run, events]);
  if (!run) return <div className="grid h-full place-items-center text-sm text-muted">选择一个运行查看概览</div>;
  return (
    <div className="scroll-thin grid h-full content-start gap-4 overflow-y-auto p-4 md:p-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-4">
        <FailureBanner error={run.error} />
        {headline && <HeadlineCard headline={headline} />}
        <PlanCard run={run} onOpenArchitecture={onOpenArchitecture} />
        <TaskTable run={run} onSelectTask={onSelectTask} />
      </div>
      <SummaryAside run={run} timeline={timeline} onOpenActivity={onOpenActivity} />
    </div>
  );
}
