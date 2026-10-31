import { ChevronDown, Play, Square } from "lucide-react";
import type { ReactNode } from "react";
import type { AutomaticEvolutionCycle, AutomaticEvolutionSnapshot } from "../../../types";
import { Badge } from "../../../ui/badge";
import { cn } from "../../../ui/cn";
import { Callout, Input } from "../../../ui/form";
import { ActionButton } from "../controls";
import { clampCycles, formatDate, formatScoreDelta } from "../format";
import {
  cycleDecisionLabel,
  latestCycle,
  roleBindingLabel,
} from "./model";

export function AutomationMetrics({
  automation,
  requestedCycles,
}: {
  automation: AutomaticEvolutionSnapshot;
  requestedCycles: number;
}) {
  const latest = latestCycle(automation);
  return (
    <div role="group" aria-label="自动演进限制" className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Metric>
        完成 <Value>{automation.completedCycles}/{automation.requestedMaxCycles ?? requestedCycles}</Value> 轮
      </Metric>
      <Metric>
        连续无提升 <Value>{automation.consecutiveNoImprovement}/{automation.maxConsecutiveNoImprovement}</Value>
      </Metric>
      <Metric>
        每个策略 <Value>{automation.evaluationRepeats}</Value> 次评测
      </Metric>
      {automation.roleBindingSource && (
        <Metric>
          角色绑定 <Value>{roleBindingLabel(automation.roleBindingSource)}</Value>
        </Metric>
      )}
      {latest && (
        <Metric>
          最近 Δ{" "}
          <Value className={latest.improved ? "text-success-ink" : "text-danger-ink"}>
            {formatScoreDelta(latest.scoreDelta)}
          </Value>
        </Metric>
      )}
    </div>
  );
}

export function AutomationControls({
  automation,
  requestedCycles,
  active,
  busy,
  mutationLocked,
  startIntentPending,
  onCyclesChange,
  onStart,
  onStop,
}: {
  automation: AutomaticEvolutionSnapshot;
  requestedCycles: number;
  active: boolean;
  busy: boolean;
  mutationLocked: boolean;
  startIntentPending: boolean;
  onCyclesChange(value: number): void;
  onStart(): void;
  onStop(): void;
}) {
  if (active) {
    return <StopControl automation={automation} busy={busy} onStop={onStop} />;
  }
  return (
    <StartControl
      automation={automation}
      requestedCycles={requestedCycles}
      busy={busy}
      mutationLocked={mutationLocked}
      startIntentPending={startIntentPending}
      onCyclesChange={onCyclesChange}
      onStart={onStart}
    />
  );
}

function StartControl({
  automation,
  requestedCycles,
  busy,
  mutationLocked,
  startIntentPending,
  onCyclesChange,
  onStart,
}: {
  automation: AutomaticEvolutionSnapshot;
  requestedCycles: number;
  busy: boolean;
  mutationLocked: boolean;
  startIntentPending: boolean;
  onCyclesChange(value: number): void;
  onStart(): void;
}) {
  return (
    <div className="flex items-center gap-2 max-sm:w-full max-sm:justify-end">
      <label className="flex items-center gap-2 whitespace-nowrap text-xs text-muted">
        <span>循环次数</span>
        <Input
          type="number"
          min={1}
          max={automation.configuredMaxCycles}
          step={1}
          value={requestedCycles}
          disabled={!automation.enabled || busy || mutationLocked || startIntentPending}
          onChange={(event) =>
            onCyclesChange(clampCycles(Number(event.target.value), automation.configuredMaxCycles))
          }
          className="h-8 w-16 px-2 text-center tabular-nums"
        />
      </label>
      <ActionButton
        variant="primary"
        onClick={onStart}
        disabled={!automation.enabled || busy || mutationLocked}
      >
        <Play />
        {startIntentPending ? "重试" : "开始"}
      </ActionButton>
    </div>
  );
}

function StopControl({
  automation,
  busy,
  onStop,
}: {
  automation: AutomaticEvolutionSnapshot;
  busy: boolean;
  onStop(): void;
}) {
  return (
    <div className="flex items-center gap-2 max-sm:w-full max-sm:justify-end">
      <ActionButton variant="danger" onClick={onStop} disabled={busy || automation.status === "stopping"}>
        <Square className="size-3.5!" />
        {automation.status === "stopping" ? "正在停止" : "停止"}
      </ActionButton>
    </div>
  );
}

export function AutomationFooter({
  automation,
  note,
  isError,
  open,
  onToggle,
}: {
  automation: AutomaticEvolutionSnapshot;
  note: string | undefined;
  isError: boolean;
  open: boolean;
  onToggle(): void;
}) {
  return (
    <div className="flex flex-col gap-2 px-4 pb-3 md:px-6">
      {note && <AutomationNote automation={automation} note={note} isError={isError} />}
      {automation.cycles.length > 0 && (
        <CyclesSection automation={automation} open={open} onToggle={onToggle} />
      )}
    </div>
  );
}

function AutomationNote({
  automation,
  note,
  isError,
}: {
  automation: AutomaticEvolutionSnapshot;
  note: string;
  isError: boolean;
}) {
  if (isError) {
    return (
      <Callout tone={automation.error ? "danger" : "warning"}>
        {automation.failureCode ? (
          <code className="mr-1 text-2xs">[{automation.failureCode}]</code>
        ) : null}
        {note}
      </Callout>
    );
  }
  return (
    <p className="m-0 text-xs leading-relaxed text-muted">
      {automation.failureCode ? `[${automation.failureCode}] ` : ""}
      {note}
    </p>
  );
}

function CyclesSection({
  automation,
  open,
  onToggle,
}: {
  automation: AutomaticEvolutionSnapshot;
  open: boolean;
  onToggle(): void;
}) {
  return (
    <div>
      <ActionButton
        variant="ghost"
        size="sm"
        className="-ml-2.5"
        onClick={onToggle}
        aria-expanded={open}
      >
        <ChevronDown className={cn("transition-transform duration-150", open && "rotate-180")} />
        轮次明细（{automation.cycles.length}）
      </ActionButton>
      {open && <CycleList cycles={automation.cycles} />}
    </div>
  );
}

function CycleList({ cycles }: { cycles: AutomaticEvolutionCycle[] }) {
  return (
    <ol className="scroll-thin m-0 mt-2 grid max-h-72 list-none gap-2 overflow-y-auto p-0 md:grid-cols-2">
      {[...cycles].reverse().map((cycle) => (
        <CycleCard key={cycle.cycle} cycle={cycle} />
      ))}
    </ol>
  );
}

function CycleCard({ cycle }: { cycle: AutomaticEvolutionCycle }) {
  return (
    <li className="bd flex min-w-0 flex-col gap-2 rounded-lg bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-xs font-semibold text-ink">第 {cycle.cycle} 轮</strong>
        <Badge tone={cycle.improved ? "success" : "neutral"}>{cycleDecisionLabel(cycle)}</Badge>
        <span className={cn("text-xs text-muted", cycle.improved ? "text-success-ink" : "text-danger-ink")}>
          Δ <strong className="font-semibold tabular-nums">{formatScoreDelta(cycle.scoreDelta)}</strong>
        </span>
        <time className="ml-auto text-2xs text-muted">{formatDate(cycle.completedAt)}</time>
      </div>
      <CycleScores cycle={cycle} />
      <p className="m-0 text-xs leading-relaxed text-muted">{cycle.rationale}</p>
    </li>
  );
}

function CycleScores({ cycle }: { cycle: AutomaticEvolutionCycle }) {
  return (
    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      <dt className="text-muted">当前策略分</dt>
      <dd className="m-0 tabular-nums text-ink-2">{cycle.incumbentScore}</dd>
      <dt className="text-muted">候选分</dt>
      <dd className="m-0 tabular-nums text-ink-2">{cycle.candidateScore}</dd>
      {cycle.candidateRunIds.length > 0 && (
        <>
          <dt className="text-muted">关联运行</dt>
          <dd className="m-0 flex flex-wrap gap-1.5 text-ink-2">
            {cycle.candidateRunIds.map((runId) => (
              <code key={runId} title={runId} className="rounded bg-surface-3 px-1.5 py-0.5 text-2xs">
                {runId.slice(0, 12)}
              </code>
            ))}
          </dd>
        </>
      )}
    </dl>
  );
}

function Metric({ children }: { children: ReactNode }) {
  return (
    <span className="bd inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-surface-2 px-2 py-1 text-2xs leading-none text-muted">
      {children}
    </span>
  );
}

function Value({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <strong className={cn("font-semibold tabular-nums text-ink-2", className)}>{children}</strong>
  );
}
