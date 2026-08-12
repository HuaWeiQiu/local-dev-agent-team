import { z } from "zod";
import { namedStrategySchema, type NamedStrategy } from "../config/schema.js";
import type { RunState } from "../state/types.js";

export const AUTOMATIC_EVOLUTION_EVALUATION_SOURCE =
  "server-automatic-run-evaluation-v1" as const;

export const automaticStrategyCandidateSchema = z
  .object({
    rationale: z.string().trim().min(1).max(2_000),
    definition: namedStrategySchema,
  })
  .strict();

export type AutomaticStrategyCandidate = z.infer<typeof automaticStrategyCandidateSchema>;

export type AutomaticEvolutionStatus =
  | "idle"
  | "running"
  | "stopping"
  | "completed"
  | "stopped"
  | "paused"
  | "failed";

export type AutomaticEvolutionPhase =
  | "idle"
  | "baseline"
  | "proposing"
  | "evaluating"
  | "deciding"
  | "applying"
  | "stopping"
  | "finished";

export interface AutomaticRunOutcome {
  runId: string;
  passed: boolean;
  score: number;
  status: RunState["status"];
  qualityPassed: boolean;
  finalDecision: string | null;
  commandsPassed: number;
  commandsTotal: number;
  tasksMerged: number;
  tasksTotal: number;
  totalAttempts: number;
  agentInvocations: number;
}

export interface AutomaticOutcomeAggregate {
  runIds: string[];
  passed: boolean;
  score: number;
  outcomes: AutomaticRunOutcome[];
}

export interface AutomaticEvolutionCycle {
  cycle: number;
  proposalId: string;
  rationale: string;
  candidateDefinition: NamedStrategy;
  candidateRunIds: string[];
  incumbentScore: number;
  candidateScore: number;
  scoreDelta: number;
  improved: boolean;
  decision: "promoted" | "rejected";
  completedAt: string;
}

export interface AutomaticEvolutionSnapshot {
  enabled: boolean;
  autoStart: boolean;
  status: AutomaticEvolutionStatus;
  phase: AutomaticEvolutionPhase;
  configuredMaxCycles: number;
  requestedMaxCycles: number | null;
  completedCycles: number;
  maxConsecutiveNoImprovement: number;
  consecutiveNoImprovement: number;
  evaluationRepeats: number;
  minimumScoreDelta: number;
  baselineStrategy: string | null;
  targetStrategy: string;
  sessionId: string | null;
  activeRunId: string | null;
  incumbentScore: number | null;
  incumbentStrategy: string | null;
  stopReason: string | null;
  error: string | null;
  /** Stable provider failure code when status is paused for infrastructure issues. */
  failureCode: string | null;
  /** Which role-binding source evaluation runs use: desktop global CLI defaults or project yaml. */
  roleBindingSource: "global-cli-defaults" | "project-yaml" | null;
  startedAt: string | null;
  updatedAt: string;
  cycles: AutomaticEvolutionCycle[];
}

export function projectRunOutcome(state: RunState): AutomaticRunOutcome {
  const commands = state.finalQuality?.commands ?? [];
  const commandsPassed = commands.filter((command) => command.exitCode === 0).length;
  const tasksMerged = state.tasks.filter((task) => task.status === "merged").length;
  const totalAttempts = state.tasks.reduce((total, task) => total + task.attempts, 0);
  const qualityPassed = state.finalQuality?.passed === true;
  const deterministicCommandsPassed =
    commands.length > 0 && commandsPassed === commands.length;
  const decision = state.finalDecision?.decision ?? null;
  const allTasksMerged = state.tasks.length > 0 && tasksMerged === state.tasks.length;
  const evaluationCompleted =
    state.status === "completed" && state.purpose === "evolution-evaluation";
  const passed =
    evaluationCompleted &&
    qualityPassed &&
    deterministicCommandsPassed &&
    decision === "ready" &&
    allTasksMerged;
  const avoidableAttempts = Math.max(0, totalAttempts - state.tasks.length);
  const agentInvocations = state.usage?.agentInvocations ?? 0;
  const score =
    (passed ? 10_000 : 0) +
    (qualityPassed ? 1_000 : 0) +
    (decision === "ready" ? 500 : 0) +
    (allTasksMerged ? 500 : 0) +
    commandsPassed * 20 -
    avoidableAttempts * 50 -
    agentInvocations * 5;
  return {
    runId: state.id,
    passed,
    score,
    status: state.status,
    qualityPassed,
    finalDecision: decision,
    commandsPassed,
    commandsTotal: commands.length,
    tasksMerged,
    tasksTotal: state.tasks.length,
    totalAttempts,
    agentInvocations,
  };
}

export function aggregateRunOutcomes(
  outcomes: AutomaticRunOutcome[],
): AutomaticOutcomeAggregate {
  if (outcomes.length === 0) throw new Error("At least one automatic evaluation outcome is required");
  return {
    runIds: outcomes.map((outcome) => outcome.runId),
    passed: outcomes.every((outcome) => outcome.passed),
    score: Math.min(...outcomes.map((outcome) => outcome.score)),
    outcomes: outcomes.map((outcome) => ({ ...outcome })),
  };
}

export function automaticCandidateImproved(
  incumbent: AutomaticOutcomeAggregate,
  candidate: AutomaticOutcomeAggregate,
  minimumScoreDelta: number,
): boolean {
  return candidate.passed && candidate.score - incumbent.score >= minimumScoreDelta;
}

export function automaticRunEvidenceItems(
  incumbent: AutomaticOutcomeAggregate,
  candidate: AutomaticOutcomeAggregate,
  minimumScoreDelta: number,
  options: { suiteDigest?: string; suiteName?: string } = {},
): Array<{ kind: "deterministic"; id: string; status: "pass" | "fail"; summary: string }> {
  const improved = automaticCandidateImproved(incumbent, candidate, minimumScoreDelta);
  return [
    {
      kind: "deterministic",
      id: "automatic-strategy-preflight-v1",
      status: "pass",
      summary: "Candidate passed the current strategy schema, topology, profile, and catalog preflight",
    },
    ...(options.suiteDigest
      ? [
          {
            kind: "deterministic" as const,
            id: "automatic-evaluation-suite-identity-v1",
            status: "pass" as const,
            summary: `Evaluation suite ${options.suiteName ?? "configured"} digest ${options.suiteDigest}`,
          },
        ]
      : []),
    ...incumbent.outcomes.map((outcome, index) => ({
      kind: "deterministic" as const,
      id: `automatic-incumbent-run-${index + 1}`,
      status: outcome.passed ? "pass" as const : "fail" as const,
      summary: runOutcomeSummary(outcome),
    })),
    ...candidate.outcomes.map((outcome, index) => ({
      kind: "deterministic" as const,
      id: `automatic-candidate-run-${index + 1}`,
      status: outcome.passed ? "pass" as const : "fail" as const,
      summary: runOutcomeSummary(outcome),
    })),
    {
      kind: "deterministic",
      id: "automatic-incumbent-comparison-v1",
      status: improved ? "pass" : "fail",
      summary: `Candidate score ${candidate.score}; incumbent score ${incumbent.score}; required delta ${minimumScoreDelta}`,
    },
  ];
}

function runOutcomeSummary(outcome: AutomaticRunOutcome): string {
  return [
    `run=${outcome.runId}`,
    `status=${outcome.status}`,
    `quality=${outcome.qualityPassed ? "pass" : "fail"}`,
    `decision=${outcome.finalDecision ?? "missing"}`,
    `commands=${outcome.commandsPassed}/${outcome.commandsTotal}`,
    `tasks=${outcome.tasksMerged}/${outcome.tasksTotal}`,
    `attempts=${outcome.totalAttempts}`,
    `agentInvocations=${outcome.agentInvocations}`,
    `score=${outcome.score}`,
  ].join("; ");
}
