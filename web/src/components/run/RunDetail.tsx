import type { RunState } from "../../types";
import {
  ApprovalsSection,
  CheckpointSection,
  DecisionSection,
  PlanCompleteness,
  QualityGate,
  RolesSection,
  RunError,
  RunSummary,
  StrategySection,
  UsageSection,
} from "./detail/sections";

/** Inspector body for one run: summary first, then the sections that apply. */
export function RunDetail({ run }: { run: RunState }) {
  return (
    <>
      <RunSummary run={run} />
      <PlanCompleteness run={run} />
      <QualityGate run={run} />
      <StrategySection run={run} />
      <RolesSection run={run} />
      <ApprovalsSection run={run} />
      <CheckpointSection run={run} />
      <UsageSection run={run} />
      <DecisionSection run={run} />
      <RunError run={run} />
    </>
  );
}
