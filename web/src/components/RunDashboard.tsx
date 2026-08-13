import { FileCheck2, Gauge, ScrollText, Workflow } from "lucide-react";
import { useMemo } from "react";
import { humanizeFailure, strategyDisplayName, summarizeGoal } from "../presentation";
import type { RunMonitor } from "../hooks/useRunEvents";
import type {
  EvidenceFilePreview,
  TaskRunState,
} from "../types";
import { DagCanvas } from "./DagCanvas";
import { EventConsole } from "./EventConsole";
import { EvidenceCenter } from "./EvidenceCenter";
import { RunRail } from "./RunRail";
import { TaskInspector } from "./TaskInspector";
import { UsagePanel } from "./UsagePanel";

export type MonitorPanel = "graph" | "activity" | "evidence" | "usage";

interface RunDashboardProps {
  /** useRunEvents 返回的运行监控数据（列表/详情/事件/证据/用量） */
  monitor: RunMonitor;
  busy: boolean;
  monitorPanel: MonitorPanel;
  onMonitorPanelChange(panel: MonitorPanel): void;
  onSelectRun(runId: string): void;
  onCreate(): void;
  onCleanup(): void;
  onDeleteRun(runId: string): Promise<void>;
  onSelectTask(task: TaskRunState): void;
  onExportEvents(): Promise<void>;
  onReadArtifact(path: string): Promise<EvidenceFilePreview>;
  onRefreshUsage(): void;
}

/** 运行监控区：运行列表 + 详情 + DAG 投影的装配（JSX 自 App.tsx 原样搬移）。 */
export function RunDashboard({
  monitor,
  busy,
  monitorPanel,
  onMonitorPanelChange,
  onSelectRun,
  onCreate,
  onCleanup,
  onDeleteRun,
  onSelectTask,
  onExportEvents,
  onReadArtifact,
  onRefreshUsage,
}: RunDashboardProps) {
  const {
    runs,
    selectedRunId,
    run,
    selectedTaskId,
    events,
    connected,
    evidence,
    evidenceLoading,
    usageReport,
    usageLoading,
  } = monitor;
  const selectedTask = useMemo(
    () => run?.tasks.find((task) => task.task.id === selectedTaskId),
    [run?.tasks, selectedTaskId],
  );
  const completedTasks = run?.tasks.filter((task) => ["passed", "merged"].includes(task.status)).length ?? 0;

  return (
    <section className="monitor-workbench" aria-label="运行工作台">
      <RunRail
        runs={runs}
        selectedRunId={selectedRunId}
        busy={busy}
        onSelect={onSelectRun}
        onCreate={onCreate}
        onCleanup={onCleanup}
        onDelete={(runId) => void onDeleteRun(runId)}
      />
      <section className="run-workspace">
        <header className="run-workspace-header">
          <div className="run-workspace-title">
            <div>
              <h1 title={run?.goal}>{run ? summarizeGoal(run.goal, 72) : "选择一个运行"}</h1>
              {run && (
                <span>
                  {strategyDisplayName(run.strategy.name)} · {completedTasks}/{run.tasks.length} 任务完成
                  {run.error ? ` · ${humanizeFailure(run.error)}` : ""}
                </span>
              )}
            </div>
          </div>
          <div className="run-view-tabs" role="tablist" aria-label="运行视图">
            <button role="tab" aria-selected={monitorPanel === "graph"} className={monitorPanel === "graph" ? "is-active" : ""} onClick={() => onMonitorPanelChange("graph")}>
              <Workflow size={16} />任务图
            </button>
            <button role="tab" aria-selected={monitorPanel === "activity"} className={monitorPanel === "activity" ? "is-active" : ""} onClick={() => onMonitorPanelChange("activity")}>
              <ScrollText size={16} />活动日志
            </button>
            <button role="tab" aria-selected={monitorPanel === "evidence"} className={monitorPanel === "evidence" ? "is-active" : ""} onClick={() => onMonitorPanelChange("evidence")}>
              <FileCheck2 size={16} />交付证据
            </button>
            <button role="tab" aria-selected={monitorPanel === "usage"} className={monitorPanel === "usage" ? "is-active" : ""} onClick={() => onMonitorPanelChange("usage")}>
              <Gauge size={16} />用量
            </button>
          </div>
        </header>
        <div className={`run-panel run-panel-graph ${monitorPanel === "graph" ? "is-active" : ""}`}>
          <DagCanvas run={run} selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} />
        </div>
        <div className={`run-panel run-panel-activity ${monitorPanel === "activity" ? "is-active" : ""}`}>
          <EventConsole run={run} events={events} connected={connected} exporting={busy} onExport={() => void onExportEvents()} />
        </div>
        <div className={`run-panel run-panel-evidence ${monitorPanel === "evidence" ? "is-active" : ""}`}>
          <EvidenceCenter run={run} evidence={evidence} loading={evidenceLoading} onReadArtifact={onReadArtifact} />
        </div>
        <div className={`run-panel run-panel-usage ${monitorPanel === "usage" ? "is-active" : ""}`}>
          <UsagePanel report={usageReport} loading={usageLoading} selectedRunId={selectedRunId} onRefresh={onRefreshUsage} />
        </div>
      </section>
      <TaskInspector run={run} task={selectedTask} />
    </section>
  );
}
