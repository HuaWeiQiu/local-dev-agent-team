import type { StageBrief } from "../../architecture";
import type { TaskRunState } from "../../types";
import {
  StageAgents,
  StageArtifactBlock,
  StageHeader,
  StageHistory,
  StageInputBlock,
  StageLedger,
  StageLiveOutput,
  StageRetries,
  StageTasks,
} from "./stage/sections";

interface StageDetailProps {
  brief: StageBrief;
  onSelectTask(task: TaskRunState): void;
}

/** Inspector body for one stage: what it received, what it produced, who ran. */
export function StageDetail({ brief, onSelectTask }: StageDetailProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <StageHeader brief={brief} />
      <StageOptionalBlocks brief={brief} />
      <StageTaskList brief={brief} onSelectTask={onSelectTask} />
    </div>
  );
}

/** Blocks that only appear when the stage actually produced them. */
function StageOptionalBlocks({ brief }: { brief: StageBrief }) {
  const { input, artifact, liveText, agents, retries } = brief;
  return (
    <>
      {input && <StageInputBlock input={input} />}
      {artifact && <StageArtifactBlock artifact={artifact} />}
      {liveText && <StageLiveOutput liveText={liveText} />}
      {agents.length > 0 && <StageAgents agents={agents} />}
      {retries !== undefined && retries > 0 && <StageRetries retries={retries} />}
      <StageTimeline brief={brief} />
    </>
  );
}

/** The ledger when there is one, otherwise the raw status history. */
function StageTimeline({ brief }: { brief: StageBrief }) {
  if (brief.ledger.length > 0) return <StageLedger ledger={brief.ledger} />;
  if (brief.history.length === 0) return null;
  return <StageHistory history={brief.history} />;
}

function StageTaskList({ brief, onSelectTask }: StageDetailProps) {
  if (brief.tasks.length === 0) return null;
  return <StageTasks tasks={brief.tasks} onSelectTask={onSelectTask} />;
}
