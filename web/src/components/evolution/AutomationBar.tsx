import { Bot, ChevronDown, Play, Square } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { AutomaticEvolutionSnapshot } from "../../types";
import { Badge } from "../../ui/badge";
import { cn } from "../../ui/cn";
import { Callout, Input } from "../../ui/form";
import { StatusDot } from "../../ui/status";
import { ActionButton } from "./controls";
import {
  automationStatusLabel,
  automationStatusText,
  automationTone,
  clampCycles,
  formatDate,
  formatScoreDelta,
} from "./format";

interface AutomationBarProps {
  automation: AutomaticEvolutionSnapshot;
  requestedCycles: number;
  busy: boolean;
  startIntentPending: boolean;
  mutationLocked: boolean;
  onCyclesChange(value: number): void;
  onStart(): void;
  onStop(): void;
}

export function AutomationBar({
  automation,
  requestedCycles,
  busy,
  startIntentPending,
  mutationLocked,
  onCyclesChange,
  onStart,
  onStop,
}: AutomationBarProps) {
  const active = automation.status === "running" || automation.status === "stopping";
  const latest = automation.cycles.at(-1);
  const [cyclesOpen, setCyclesOpen] = useState(false);
  const tone = automationTone(automation.status);
  const note = automation.error ?? (!active ? automation.stopReason : undefined);
  const noteIsError = Boolean(automation.error) || automation.status === "paused";

  return (
    <section aria-label="自动演进控制" className="bd-b shrink-0 bg-surface">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 md:px-6">
        <div className="flex min-w-0 flex-1 basis-60 items-center gap-3">
          <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink [&_svg]:size-[18px]">
            <Bot />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <strong className="text-sm font-semibold text-ink">自动演进</strong>
              <Badge tone={tone}>
                <StatusDot tone={tone} pulse={tone === "active"} className="size-1.5" />
                {automationStatusLabel(automation.status)}
              </Badge>
            </div>
            <span className="mt-0.5 block truncate text-xs text-muted">
              {automation.enabled ? automationStatusText(automation) : "当前项目未启用"}
            </span>
          </div>
        </div>

        {automation.enabled && (
          <div role="group" aria-label="自动演进限制" className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Metric>完成 <Value>{automation.completedCycles}/{automation.requestedMaxCycles ?? requestedCycles}</Value> 轮</Metric>
            <Metric>连续无提升 <Value>{automation.consecutiveNoImprovement}/{automation.maxConsecutiveNoImprovement}</Value></Metric>
            <Metric>每个策略 <Value>{automation.evaluationRepeats}</Value> 次评测</Metric>
            {automation.roleBindingSource && (
              <Metric>
                角色绑定{" "}
                <Value>
                  {automation.roleBindingSource === "layered-cli-defaults" || automation.roleBindingSource === "global-cli-defaults"
                    ? "全局/项目默认"
                    : "项目 yaml"}
                </Value>
              </Metric>
            )}
            {latest && (
              <Metric>
                最近 Δ <Value className={latest.improved ? "text-success-ink" : "text-danger-ink"}>{formatScoreDelta(latest.scoreDelta)}</Value>
              </Metric>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 max-sm:w-full max-sm:justify-end">
          {!active ? (
            <>
              <label className="flex items-center gap-2 whitespace-nowrap text-xs text-muted">
                <span>循环次数</span>
                <Input
                  type="number"
                  min={1}
                  max={automation.configuredMaxCycles}
                  step={1}
                  value={requestedCycles}
                  disabled={!automation.enabled || busy || mutationLocked || startIntentPending}
                  onChange={(event) => onCyclesChange(clampCycles(Number(event.target.value), automation.configuredMaxCycles))}
                  className="h-8 w-16 px-2 text-center tabular-nums"
                />
              </label>
              <ActionButton variant="primary" onClick={onStart} disabled={!automation.enabled || busy || mutationLocked}>
                <Play />
                {startIntentPending ? "重试" : "开始"}
              </ActionButton>
            </>
          ) : (
            <ActionButton variant="danger" onClick={onStop} disabled={busy || automation.status === "stopping"}>
              <Square className="size-3.5!" />
              {automation.status === "stopping" ? "正在停止" : "停止"}
            </ActionButton>
          )}
        </div>
      </div>

      {(automation.cycles.length > 0 || note) && (
        <div className="flex flex-col gap-2 px-4 pb-3 md:px-6">
          {note && (
            noteIsError ? (
              <Callout tone={automation.error ? "danger" : "warning"}>
                {automation.failureCode ? <code className="mr-1 text-2xs">[{automation.failureCode}]</code> : null}
                {note}
              </Callout>
            ) : (
              <p className="m-0 text-xs leading-relaxed text-muted">
                {automation.failureCode ? `[${automation.failureCode}] ` : ""}
                {note}
              </p>
            )
          )}
          {automation.cycles.length > 0 && (
            <div>
              <ActionButton
                variant="ghost"
                size="sm"
                className="-ml-2.5"
                onClick={() => setCyclesOpen((value) => !value)}
                aria-expanded={cyclesOpen}
              >
                <ChevronDown className={cn("transition-transform duration-150", cyclesOpen && "rotate-180")} />
                轮次明细（{automation.cycles.length}）
              </ActionButton>
              {cyclesOpen && (
                <ol className="scroll-thin m-0 mt-2 grid max-h-72 list-none gap-2 overflow-y-auto p-0 md:grid-cols-2">
                  {[...automation.cycles].reverse().map((cycle) => (
                    <li key={cycle.cycle} className="bd flex min-w-0 flex-col gap-2 rounded-lg bg-surface-2 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="text-xs font-semibold text-ink">第 {cycle.cycle} 轮</strong>
                        <Badge tone={cycle.improved ? "success" : "neutral"}>
                          {cycle.decision === "promoted" ? "已采纳" : "未采纳"}
                        </Badge>
                        <span className={cn("text-xs text-muted", cycle.improved ? "text-success-ink" : "text-danger-ink")}>
                          Δ <strong className="font-semibold tabular-nums">{formatScoreDelta(cycle.scoreDelta)}</strong>
                        </span>
                        <time className="ml-auto text-2xs text-muted">{formatDate(cycle.completedAt)}</time>
                      </div>
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
                                <code key={runId} title={runId} className="rounded bg-surface-3 px-1.5 py-0.5 text-2xs">{runId.slice(0, 12)}</code>
                              ))}
                            </dd>
                          </>
                        )}
                      </dl>
                      <p className="m-0 text-xs leading-relaxed text-muted">{cycle.rationale}</p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
      )}
    </section>
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
  return <strong className={cn("font-semibold tabular-nums text-ink-2", className)}>{children}</strong>;
}
