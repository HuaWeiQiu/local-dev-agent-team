import type { ReactNode } from "react";
import {
  Bot,
  CircleHelp,
  FileCheck2,
  Gauge,
  LayoutDashboard,
  Lightbulb,
  PanelRight,
  ScrollText,
  Workflow,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "../../ui/tabs";
import { RunStatusPill } from "../../ui/status";
import { formatRelative } from "../../time";
import { strategyDisplayName } from "../../presentation";
import { StageStepper } from "../StageStepper";
import { ApprovalCard } from "../ApprovalCard";
import { RunLiveBar } from "../RunLiveBar";
import type { MonitorPanel } from "../RunPage";
import type { ApprovalRequest, RunState } from "../../types";
import type { RunPageState } from "./hooks";

export const RUN_TABS: Array<{ value: MonitorPanel; label: string; icon: typeof Workflow }> = [
  { value: "overview", label: "概览", icon: LayoutDashboard },
  { value: "graph", label: "架构", icon: Workflow },
  { value: "details", label: "详情", icon: PanelRight },
  { value: "agents", label: "智能体", icon: Bot },
  { value: "activity", label: "活动日志", icon: ScrollText },
  { value: "evidence", label: "交付证据", icon: FileCheck2 },
  { value: "insights", label: "洞察", icon: Lightbulb },
  { value: "usage", label: "用量", icon: Gauge },
];

export function RunPageHeader({
  run,
  state,
  panel,
  wide,
  onPanelChange,
  onSelectStage,
}: {
  run: RunState;
  state: RunPageState;
  panel: MonitorPanel;
  wide: boolean;
  onPanelChange(panel: MonitorPanel): void;
  onSelectStage(stage: Parameters<RunPageState["setSelectedStageId"]>[0]): void;
}) {
  return (
    <header className="bd-b bg-surface px-4 pt-4 md:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <RunStatusPill status={run.status} />
        <span className="text-xs text-muted">
          {strategyDisplayName(run.strategy.name)} · {state.done}/{run.tasks.length} 任务完成 · 创建于{" "}
          {formatRelative(run.createdAt)}
        </span>
      </div>
      <h2
        className="m-0 mt-1.5 line-clamp-2 text-xl font-semibold leading-snug tracking-tight text-ink"
        title={run.goal}
      >
        {run.goal}
      </h2>
      <div className="mt-3.5">
        <StageStepper
          run={run}
          {...(state.activeStageId ? { selectedStageId: state.activeStageId } : {})}
          onSelectStage={onSelectStage}
        />
      </div>
      <RunTabs panel={panel} wide={wide} agentCount={state.liveAgents.agents.length} onChange={onPanelChange} />
    </header>
  );
}

export function RunTabs({
  panel,
  wide,
  agentCount,
  onChange,
}: {
  panel: MonitorPanel;
  wide: boolean;
  agentCount: number;
  onChange(panel: MonitorPanel): void;
}) {
  return (
    <Tabs value={panel} onValueChange={(value) => onChange(value as MonitorPanel)} className="mt-2">
      <TabsList role="tablist" aria-label="运行视图" className="scroll-thin -mb-px overflow-x-auto border-b-0">
        {visibleTabs(wide).map(({ value, label, icon: Icon }) => (
          <TabsTrigger key={value} value={value} className="shrink-0">
            <Icon />
            {label}
            {value === "agents" && agentCount > 0 ? (
              <span className="ml-1 rounded-full bg-accent-soft px-1.5 text-2xs text-accent-ink">
                {agentCount}
              </span>
            ) : null}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

function visibleTabs(wide: boolean) {
  if (wide) return RUN_TABS;
  return RUN_TABS.filter((tab) => tab.value !== "details");
}

export function RunAlerts({
  state,
  run,
  busy,
  pendingApproval,
  onOpenActivity,
  onOpenAgents,
  onReview,
}: {
  state: RunPageState;
  run: RunState;
  busy: boolean;
  pendingApproval: ApprovalRequest | undefined;
  onOpenActivity(): void;
  onOpenAgents(): void;
  onReview(): void;
}): ReactNode {
  if (!needsAlerts(state, pendingApproval)) return null;
  return (
    <div className="flex flex-col gap-2.5 px-4 pt-3.5 md:px-6">
      {state.questionCount > 0 && (
        <button
          type="button"
          onClick={onOpenAgents}
          className="flex cursor-pointer items-center gap-2 rounded-lg border border-solid border-warning/40 bg-warning-soft px-4 py-2.5 text-left text-sm font-medium text-warning-ink focus-ring"
        >
          <CircleHelp className="size-4" aria-hidden />
          {state.questionCount} 个智能体问题等你回答
          <span className="ml-auto text-xs font-normal underline">去回答</span>
        </button>
      )}
      {state.liveStatus && <RunLiveBar status={state.liveStatus} onOpenActivity={onOpenActivity} />}
      {pendingApproval && (
        <ApprovalCard run={run} approval={pendingApproval} busy={busy} onReview={onReview} />
      )}
    </div>
  );
}

export function needsAlerts(state: RunPageState, pendingApproval: ApprovalRequest | undefined): boolean {
  return Boolean(
    state.liveStatus?.running || state.liveStatus?.pendingApprovals || pendingApproval || state.questionCount > 0,
  );
}

export function RunGrid({
  inspector,
  children,
  showInspector,
  wide,
}: {
  inspector: ReactNode;
  children: ReactNode;
  showInspector: boolean;
  wide: boolean;
}) {
  const twoColumns = showInspector && wide;
  return (
    <div
      className={
        twoColumns
          ? "grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] grid-cols-[minmax(0,1fr)_348px]"
          : "grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] grid-cols-1"
      }
    >
      <div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] [&>*]:col-start-1 [&>*]:row-start-1">
        {children}
      </div>
      {twoColumns && inspector}
    </div>
  );
}

export function Panel({ active, children }: { active: boolean; children: ReactNode }) {
  return <div className={active ? "flex min-h-0 min-w-0 flex-col" : "hidden"}>{children}</div>;
}

export function EmptyRun({ hasSelection }: { hasSelection: boolean }) {
  return (
    <section aria-label="运行工作台" className="grid h-full place-items-center text-sm text-muted">
      <span role="status">{hasSelection ? "正在加载运行…" : "选择一个运行"}</span>
    </section>
  );
}
