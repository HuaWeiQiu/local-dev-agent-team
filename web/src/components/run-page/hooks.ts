import { useMemo, useState } from "react";
import { deriveAgentActivity } from "../../agent-activity";
import { useLiveAgents } from "../../hooks/useLiveAgents";
import { useRunInsights } from "../../hooks/useRunInsights";
import { latestPendingApproval } from "../../hooks/useRunEvents";
import { deriveLiveStatus } from "../../live-status";
import { currentStageId, describeStage, stageForTask } from "../../architecture";
import type { StageId } from "../../stages";
import type { MonitorPanel } from "../RunPage";
import type { RunEvent, RunState, TaskRunState } from "../../types";

const activeRunStatuses = new Set(["created", "orchestrating", "planning", "implementing", "reviewing", "testing"]);

export interface RunPageState {
  selectedTask: TaskRunState | undefined;
  activeStageId: StageId | undefined;
  stageBrief: ReturnType<typeof describeStage> | undefined;
  liveStatus: ReturnType<typeof deriveLiveStatus> | undefined;
  pendingApproval: ReturnType<typeof latestPendingApproval>;
  done: number;
  showInspector: boolean;
  runActive: boolean;
  liveAgents: ReturnType<typeof useLiveAgents>;
  insights: ReturnType<typeof useRunInsights>;
  questionCount: number;
  selectedModuleId: string | undefined;
  setSelectedStageId(value: StageId | undefined): void;
  setSelectedModuleId(value: string | undefined): void;
}

/** Derived state for the run workspace, split out of the render function. */
export function useRunPageState(input: {
  scope: Parameters<typeof useLiveAgents>[0];
  monitor: {
    selectedRunId: string | undefined;
    run: RunState | undefined;
    selectedTaskId: string | undefined;
    events: RunEvent[];
  };
  monitorPanel: MonitorPanel;
}): RunPageState {
  const { run, selectedTaskId, events } = input.monitor;
  const [selectedStageId, setSelectedStageId] = useState<StageId | undefined>();
  const [selectedModuleId, setSelectedModuleId] = useState<string | undefined>();
  const selectedTask = useMemo(
    () => run?.tasks.find((task) => task.task.id === selectedTaskId),
    [run?.tasks, selectedTaskId],
  );
  const activeStageId = selectedStageId ?? (run ? currentStageId(run) : undefined);
  const stageBrief = selectedStage(stageMemoArgs(run, selectedStageId, events));
  const liveStatus = useMemo(
    () => deriveLiveStatus(run, deriveAgentActivity(events, run?.status)),
    [run, events],
  );
  const pendingApproval = useMemo(() => latestPendingApproval(run), [run]);
  const runActive = run ? activeRunStatuses.has(run.status) : false;
  const liveAgents = useLiveAgents(input.scope, input.monitor.selectedRunId, events, runActive);
  const insights = useRunInsights(
    input.scope,
    input.monitor.selectedRunId,
    run?.updatedAt,
    input.monitorPanel === "insights",
  );
  return {
    selectedTask,
    activeStageId,
    stageBrief,
    liveStatus,
    pendingApproval,
    done: countDone(run),
    showInspector: input.monitorPanel === "graph",
    runActive,
    liveAgents,
    insights,
    questionCount: liveAgents.agents.reduce(
      (total, agent) => total + agent.questions.length,
      0,
    ),
    selectedModuleId,
    setSelectedStageId,
    setSelectedModuleId,
  };
}

function countDone(run: RunState | undefined): number {
  return run?.tasks.filter((task) => ["passed", "merged"].includes(task.status)).length ?? 0;
}

function stageMemoArgs(
  run: RunState | undefined,
  selectedStageId: StageId | undefined,
  events: RunEvent[],
): { run: RunState | undefined; stage: StageId | undefined; events: RunEvent[] } {
  return { run, stage: selectedStageId, events };
}

function selectedStage(input: {
  run: RunState | undefined;
  stage: StageId | undefined;
  events: RunEvent[];
}): ReturnType<typeof describeStage> | undefined {
  if (!input.run || !input.stage) return undefined;
  return describeStage(input.run, input.stage, input.events);
}

export interface RunPageHandlers {
  selectStageFromStepper(stage: StageId): void;
  openTask(task: TaskRunState): void;
  openTaskFromOverview(task: TaskRunState): void;
  openArchitecture(): void;
  openTaskInDag(task: TaskRunState): void;
  openStageInDag(stage: StageId): void;
  openModuleInDag(moduleId: string): void;
  clearModule(): void;
  openActivity(): void;
  openDetails(): void;
}

/** Navigation intents: where a click in this workspace goes. */
export function useRunPageHandlers(input: {
  wide: boolean;
  setSelectedStageId(value: StageId | undefined): void;
  setSelectedModuleId(value: string | undefined): void;
  onSelectTask(task: TaskRunState | undefined): void;
  onMonitorPanelChange(panel: MonitorPanel): void;
}): RunPageHandlers {
  const { wide, setSelectedStageId, setSelectedModuleId, onSelectTask, onMonitorPanelChange } = input;
  const select = (stage: StageId | undefined, panel: MonitorPanel): void => {
    setSelectedStageId(stage);
    setSelectedModuleId(undefined);
    onMonitorPanelChange(panel);
  };
  return {
    selectStageFromStepper: (stage) => {
      select(stage, "graph");
      onSelectTask(undefined);
    },
    openTask: (task) => {
      setSelectedStageId(stageForTask(task));
      setSelectedModuleId(undefined);
      onSelectTask(task);
    },
    openTaskFromOverview: (task) => {
      setSelectedStageId(stageForTask(task));
      setSelectedModuleId(undefined);
      onSelectTask(task);
      onMonitorPanelChange("graph");
    },
    openArchitecture: () => {
      setSelectedModuleId(undefined);
      onSelectTask(undefined);
      onMonitorPanelChange("graph");
    },
    openTaskInDag: (task) => {
      setSelectedStageId(stageForTask(task));
      setSelectedModuleId(undefined);
      onSelectTask(task);
      if (!wide) onMonitorPanelChange("details");
    },
    openStageInDag: (stage) => {
      setSelectedStageId(stage);
      setSelectedModuleId(undefined);
      onSelectTask(undefined);
      if (!wide) onMonitorPanelChange("details");
    },
    openModuleInDag: (moduleId) => {
      setSelectedModuleId(moduleId);
      onSelectTask(undefined);
      if (!wide) onMonitorPanelChange("details");
    },
    clearModule: () => setSelectedModuleId(undefined),
    openActivity: () => onMonitorPanelChange("activity"),
    openDetails: () => onMonitorPanelChange("details"),
  };
}
