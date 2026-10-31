import type { RunState, TaskDiff, TaskRunState } from "../../types";
import {
  TaskContract,
  TaskDiffBlock,
  TaskErrors,
  TaskExecution,
  TaskHeader,
  TaskPaths,
  TaskQuality,
  TaskReview,
} from "./detail/task-sections";

/** Inspector body for one task: the plan contract, then what actually happened. */
export function TaskDetail({
  task,
  run,
  onLoadDiff,
}: {
  task: TaskRunState;
  run?: RunState;
  onLoadDiff?: (taskId: string) => Promise<TaskDiff>;
}) {
  return (
    <>
      <TaskHeader task={task} />
      <TaskContract task={task} />
      <TaskExecution task={task} />
      {onLoadDiff && <TaskDiffBlock task={task} onLoadDiff={onLoadDiff} />}
      <TaskPaths task={task} />
      <TaskQuality task={task} />
      <TaskReview task={task} />
      <TaskErrors task={task} run={run} />
    </>
  );
}
