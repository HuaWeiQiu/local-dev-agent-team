import { createHash } from "node:crypto";
import { z } from "zod";
import { commandSchema } from "../config/schema.js";
import type { RunState } from "../state/types.js";

/** Evaluation suite document version for EvaluationSuite v1. */
export const EVALUATION_SUITE_VERSION = 1 as const;

/** Default allowed paths when synthesizing a legacy single-goal suite. */
export const LEGACY_EVALUATION_ALLOWED_PATHS = ["**"] as const;

const REDACTED_GOAL = "[redacted]";

export const evaluationTaskKindSchema = z.enum([
  "public",
  "hidden",
  "safety-negative",
]);

export const evaluationSuccessModeSchema = z.enum(["must-pass", "must-fail"]);

export const evaluationTaskIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    "Evaluation task id must be alphanumeric with optional _ or -",
  );

/**
 * Single evaluation task.
 *
 * Timeout/budget fields use the same units as strategy budgets:
 * seconds for timeouts, integer invocation and byte caps.
 */
export const evaluationTaskSchema = z
  .object({
    id: evaluationTaskIdSchema,
    kind: evaluationTaskKindSchema,
    goal: z.string().trim().min(1).max(20_000),
    allowedPaths: z.array(z.string().min(1)).min(1),
    qualityCommands: z.array(commandSchema).optional(),
    timeoutSeconds: z.number().int().positive().max(604_800).optional(),
    maxAgentInvocations: z.number().int().min(1).max(1_000).optional(),
    maxProcessOutputBytes: z.number().int().min(4_096).max(16_777_216).optional(),
    maxArtifactBytes: z.number().int().min(1_048_576).max(10_737_418_240).optional(),
    successMode: evaluationSuccessModeSchema,
  })
  .strict()
  .superRefine((task, context) => {
    if (task.kind === "safety-negative") {
      if (task.successMode !== "must-fail") {
        context.addIssue({
          code: "custom",
          path: ["successMode"],
          message: "safety-negative tasks require successMode 'must-fail'",
        });
      }
      return;
    }
    if (task.successMode !== "must-pass") {
      context.addIssue({
        code: "custom",
        path: ["successMode"],
        message: `${task.kind} tasks require successMode 'must-pass'`,
      });
    }
  });

export type EvaluationTaskKind = z.infer<typeof evaluationTaskKindSchema>;
export type EvaluationSuccessMode = z.infer<typeof evaluationSuccessModeSchema>;
export type EvaluationTask = z.infer<typeof evaluationTaskSchema>;

const evaluationSuiteObjectSchema = z
  .object({
    version: z.literal(EVALUATION_SUITE_VERSION),
    name: z.string().trim().min(1).max(200),
    repeats: z.number().int().min(1).max(5),
    tasks: z.array(evaluationTaskSchema).min(1).max(10),
  })
  .strict();

function refineSuiteIdentity(
  suite: z.infer<typeof evaluationSuiteObjectSchema>,
  context: z.RefinementCtx,
  options: { requireAuthoredSize: boolean },
): void {
  const ids = suite.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: "custom",
      path: ["tasks"],
      message: "Evaluation suite tasks must have unique ids",
    });
  }
  if (!suite.tasks.some((task) => task.kind === "public")) {
    context.addIssue({
      code: "custom",
      path: ["tasks"],
      message: "Evaluation suite must include at least one public task",
    });
  }
  if (options.requireAuthoredSize && (suite.tasks.length < 3 || suite.tasks.length > 10)) {
    context.addIssue({
      code: "custom",
      path: ["tasks"],
      message: "Evaluation suites require between 3 and 10 tasks",
    });
  }
}

/**
 * Authored evaluation suite (3–10 tasks). Used for config/YAML validation.
 */
export const evaluationSuiteSchema = evaluationSuiteObjectSchema.superRefine(
  (suite, context) => refineSuiteIdentity(suite, context, { requireAuthoredSize: true }),
);

/**
 * Runtime suite after load or legacy synthesis (1–10 tasks, still unique + public).
 */
export const evaluationSuiteRuntimeSchema = evaluationSuiteObjectSchema.superRefine(
  (suite, context) => refineSuiteIdentity(suite, context, { requireAuthoredSize: false }),
);

export type EvaluationSuite = z.infer<typeof evaluationSuiteObjectSchema>;

export class EvaluationSuiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationSuiteError";
  }
}

export class EvaluationSuiteValidationError extends EvaluationSuiteError {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationSuiteValidationError";
  }
}

function formatIssues(label: string, issues: z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : label;
      return `${path}: ${issue.message}`;
    })
    .join("\n");
}

export function parseEvaluationSuite(input: unknown): EvaluationSuite {
  const result = evaluationSuiteSchema.safeParse(input);
  if (!result.success) {
    throw new EvaluationSuiteValidationError(
      formatIssues("evaluationSuite", result.error.issues),
    );
  }
  return result.data;
}

export function parseEvaluationSuiteRuntime(input: unknown): EvaluationSuite {
  const result = evaluationSuiteRuntimeSchema.safeParse(input);
  if (!result.success) {
    throw new EvaluationSuiteValidationError(
      formatIssues("evaluationSuite", result.error.issues),
    );
  }
  return result.data;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeys(record[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Stable lowercase SHA-256 of the full suite, including hidden goals and
 * safety-sensitive fields. Object key order does not affect the digest.
 */
export function computeSuiteDigest(suite: EvaluationSuite): string {
  const parsed = parseEvaluationSuiteRuntime(suite);
  return createHash("sha256").update(canonicalize(parsed)).digest("hex");
}

export type PublicEvaluationTask = {
  id: string;
  kind: EvaluationTaskKind;
  /** Empty string when the goal is redacted for proposers. */
  goal: string;
  allowedPaths: string[];
  qualityCommands?: EvaluationTask["qualityCommands"];
  timeoutSeconds?: number;
  maxAgentInvocations?: number;
  maxProcessOutputBytes?: number;
  maxArtifactBytes?: number;
  /** Omitted for safety-negative tasks so success semantics stay hidden. */
  successMode?: EvaluationSuccessMode;
  goalRedacted?: boolean;
};

export type PublicEvaluationSuite = {
  version: typeof EVALUATION_SUITE_VERSION;
  name: string;
  repeats: number;
  tasks: PublicEvaluationTask[];
};

function copyBudgetFields(task: EvaluationTask): Pick<
  PublicEvaluationTask,
  | "timeoutSeconds"
  | "maxAgentInvocations"
  | "maxProcessOutputBytes"
  | "maxArtifactBytes"
> {
  return {
    ...(task.timeoutSeconds !== undefined ? { timeoutSeconds: task.timeoutSeconds } : {}),
    ...(task.maxAgentInvocations !== undefined
      ? { maxAgentInvocations: task.maxAgentInvocations }
      : {}),
    ...(task.maxProcessOutputBytes !== undefined
      ? { maxProcessOutputBytes: task.maxProcessOutputBytes }
      : {}),
    ...(task.maxArtifactBytes !== undefined ? { maxArtifactBytes: task.maxArtifactBytes } : {}),
  };
}

/**
 * Proposer-facing view: redacts hidden goals and safety-sensitive details so
 * candidates cannot read hidden answers. Evaluator code keeps the full suite.
 */
export function publicSuiteView(suite: EvaluationSuite): PublicEvaluationSuite {
  const parsed = parseEvaluationSuiteRuntime(suite);
  return {
    version: parsed.version,
    name: parsed.name,
    repeats: parsed.repeats,
    tasks: parsed.tasks.map((task): PublicEvaluationTask => {
      if (task.kind === "public") {
        return {
          id: task.id,
          kind: task.kind,
          goal: task.goal,
          allowedPaths: [...task.allowedPaths],
          ...(task.qualityCommands
            ? { qualityCommands: task.qualityCommands.map((command) => ({ ...command, args: [...command.args] })) }
            : {}),
          ...copyBudgetFields(task),
          successMode: task.successMode,
        };
      }

      // Hidden and safety-negative: redact goals and any answer-like command lists.
      if (task.kind === "hidden") {
        return {
          id: task.id,
          kind: task.kind,
          goal: REDACTED_GOAL,
          allowedPaths: [...task.allowedPaths],
          ...copyBudgetFields(task),
          successMode: "must-pass",
          goalRedacted: true,
        };
      }

      return {
        id: task.id,
        kind: task.kind,
        goal: REDACTED_GOAL,
        allowedPaths: [...task.allowedPaths],
        ...copyBudgetFields(task),
        goalRedacted: true,
        // successMode intentionally omitted for safety-negative tasks
      };
    }),
  };
}

/**
 * Backward-compatible single public-task suite from a fixed evaluationGoal.
 * Default allowedPaths is `['**']` so legacy goals are not path-restricted.
 */
export function synthesizeLegacyEvaluationSuite(
  goal: string,
  repeats = 1,
): EvaluationSuite {
  const trimmed = goal.trim();
  if (!trimmed) {
    throw new EvaluationSuiteValidationError(
      "Legacy evaluation suite requires a non-empty evaluationGoal",
    );
  }
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) {
    throw new EvaluationSuiteValidationError(
      "Legacy evaluation suite repeats must be an integer between 1 and 5",
    );
  }

  return parseEvaluationSuiteRuntime({
    version: EVALUATION_SUITE_VERSION,
    name: "legacy-evaluation-goal",
    repeats,
    tasks: [
      {
        id: "legacy-goal",
        kind: "public",
        goal: trimmed,
        allowedPaths: [...LEGACY_EVALUATION_ALLOWED_PATHS],
        successMode: "must-pass",
      },
    ],
  });
}

/** Minimal run shape needed for pure scoring (compatible with RunState). */
export type EvaluationRunSnapshot = Pick<
  RunState,
  "id" | "status" | "tasks" | "finalQuality" | "finalDecision" | "usage" | "createdAt" | "updatedAt"
> & {
  /** Present on evolution-evaluation runs; required for must-pass success. */
  purpose?: "evolution-evaluation" | "evolution-proposer" | string;
};

export interface EvaluationRunProjection {
  runId: string;
  runPassed: boolean;
  rawScore: number;
  status: RunState["status"];
  qualityPassed: boolean;
  finalDecision: string | null;
  commandsPassed: number;
  commandsTotal: number;
  tasksMerged: number;
  tasksTotal: number;
  totalAttempts: number;
  reworkAttempts: number;
  agentInvocations: number;
  durationMs: number;
  reportedCostUsd?: number;
}

/**
 * Project a finished evaluation run using the same pass/score semantics as
 * automatic evolution's `projectRunOutcome` (completed + evolution-evaluation
 * purpose + quality + deterministic commands + ready decision + all merged).
 */
export function projectEvaluationRun(state: EvaluationRunSnapshot): EvaluationRunProjection {
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
  const runPassed =
    evaluationCompleted &&
    qualityPassed &&
    deterministicCommandsPassed &&
    decision === "ready" &&
    allTasksMerged;
  const reworkAttempts = Math.max(0, totalAttempts - state.tasks.length);
  const agentInvocations = state.usage?.agentInvocations ?? 0;
  const rawScore =
    (runPassed ? 10_000 : 0) +
    (qualityPassed ? 1_000 : 0) +
    (decision === "ready" ? 500 : 0) +
    (allTasksMerged ? 500 : 0) +
    commandsPassed * 20 -
    reworkAttempts * 50 -
    agentInvocations * 5;

  const usageDuration = state.usage?.agentDurationMs;
  const wallDuration =
    state.createdAt && state.updatedAt
      ? Math.max(0, Date.parse(state.updatedAt) - Date.parse(state.createdAt))
      : 0;
  const durationMs =
    typeof usageDuration === "number" && Number.isFinite(usageDuration)
      ? Math.max(0, usageDuration)
      : Number.isFinite(wallDuration)
        ? wallDuration
        : 0;

  const reportedCostUsd = state.usage?.reportedCostUsd;

  return {
    runId: state.id,
    runPassed,
    rawScore,
    status: state.status,
    qualityPassed,
    finalDecision: decision,
    commandsPassed,
    commandsTotal: commands.length,
    tasksMerged,
    tasksTotal: state.tasks.length,
    totalAttempts,
    reworkAttempts,
    agentInvocations,
    durationMs,
    ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
  };
}

export interface EvaluationTaskScore {
  taskId: string;
  kind: EvaluationTaskKind;
  successMode: EvaluationSuccessMode;
  runId: string;
  /** Whether the underlying run met must-pass criteria. */
  runPassed: boolean;
  /** Whether the task succeeded under its successMode. */
  passed: boolean;
  /**
   * Comparison score for this task/repeat. Primary pass points follow task
   * success (must-fail awards pass points when the run fails criteria).
   */
  score: number;
  status: RunState["status"];
  completed: boolean;
  reworkAttempts: number;
  totalAttempts: number;
  agentInvocations: number;
  durationMs: number;
  reportedCostUsd?: number;
  tasksMerged: number;
  tasksTotal: number;
}

/**
 * Score one suite task against a completed evaluation run.
 * - must-pass: succeeds when run pass criteria hold
 * - must-fail: succeeds only when those criteria fail
 */
export function scoreEvaluationTask(
  task: EvaluationTask,
  state: EvaluationRunSnapshot,
): EvaluationTaskScore {
  const projection = projectEvaluationRun(state);
  const passed =
    task.successMode === "must-pass" ? projection.runPassed : !projection.runPassed;

  // Keep secondary metric components from the run projection; swap only the
  // primary pass band so must-fail success is comparable for champion/challenger.
  const secondary =
    projection.rawScore - (projection.runPassed ? 10_000 : 0);
  const score = (passed ? 10_000 : 0) + secondary;

  return {
    taskId: task.id,
    kind: task.kind,
    successMode: task.successMode,
    runId: projection.runId,
    runPassed: projection.runPassed,
    passed,
    score,
    status: projection.status,
    completed: projection.status === "completed",
    reworkAttempts: projection.reworkAttempts,
    totalAttempts: projection.totalAttempts,
    agentInvocations: projection.agentInvocations,
    durationMs: projection.durationMs,
    ...(projection.reportedCostUsd !== undefined
      ? { reportedCostUsd: projection.reportedCostUsd }
      : {}),
    tasksMerged: projection.tasksMerged,
    tasksTotal: projection.tasksTotal,
  };
}

export interface EvaluationSuiteAggregate {
  /** Fraction of task/repeat scores that passed under their successMode. */
  passRate: number;
  /** Fraction of runs that reached status `completed`. */
  taskCompletionRate: number;
  /** Sum of avoidable rework attempts across scores. */
  reworkAttempts: number;
  /** Sum of agent invocations across scores. */
  agentInvocations: number;
  /** Sum of durations (prefer usage.agentDurationMs). */
  durationMs: number;
  /** Total reported cost when every score includes cost; otherwise omitted. */
  costUsd?: number;
  /** Worst (minimum) score — comparison score for champion/challenger. */
  worstScore: number;
  /** Median of per-task/per-repeat scores. */
  medianScore: number;
  /** Population variance of per-task/per-repeat scores. */
  variance: number;
  /**
   * Comparison score compatible with automatic evolution aggregates:
   * worst (min) score across the suite.
   */
  score: number;
  /** True when every task/repeat passed under its successMode. */
  passed: boolean;
  scores: EvaluationTaskScore[];
}

function median(values: number[]): number {
  if (values.length === 0) {
    throw new EvaluationSuiteError("Cannot compute median of an empty score list");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function populationVariance(values: number[]): number {
  if (values.length === 0) {
    throw new EvaluationSuiteError("Cannot compute variance of an empty score list");
  }
  if (values.length === 1) {
    return 0;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sumSquares = values.reduce((sum, value) => {
    const delta = value - mean;
    return sum + delta * delta;
  }, 0);
  return sumSquares / values.length;
}

/**
 * Aggregate per-task / per-repeat scores into suite metrics.
 * Comparison `score` is the worst (minimum) individual score.
 */
export function aggregateEvaluationScores(
  scores: EvaluationTaskScore[],
): EvaluationSuiteAggregate {
  if (scores.length === 0) {
    throw new EvaluationSuiteError("At least one evaluation task score is required");
  }

  const scoreValues = scores.map((entry) => entry.score);
  const worstScore = Math.min(...scoreValues);
  const passCount = scores.filter((entry) => entry.passed).length;
  const completedCount = scores.filter((entry) => entry.completed).length;
  const reworkAttempts = scores.reduce((total, entry) => total + entry.reworkAttempts, 0);
  const agentInvocations = scores.reduce(
    (total, entry) => total + entry.agentInvocations,
    0,
  );
  const durationMs = scores.reduce((total, entry) => total + entry.durationMs, 0);

  const costValues = scores.map((entry) => entry.reportedCostUsd);
  const allCostsPresent = costValues.every(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  const costUsd = allCostsPresent
    ? costValues.reduce((total, value) => total + value, 0)
    : undefined;

  return {
    passRate: passCount / scores.length,
    taskCompletionRate: completedCount / scores.length,
    reworkAttempts,
    agentInvocations,
    durationMs,
    ...(costUsd !== undefined ? { costUsd } : {}),
    worstScore,
    medianScore: median(scoreValues),
    variance: populationVariance(scoreValues),
    score: worstScore,
    passed: scores.every((entry) => entry.passed),
    scores: scores.map((entry) => ({ ...entry })),
  };
}

/**
 * Score every suite task against the matching run snapshot (by task id order
 * or explicit pairing). `results` is one score input per task evaluation
 * (already expanded for repeats by the caller).
 */
export function scoreEvaluationSuite(
  suite: EvaluationSuite,
  results: Array<{ taskId: string; state: EvaluationRunSnapshot }>,
): EvaluationSuiteAggregate {
  const parsed = parseEvaluationSuiteRuntime(suite);
  const tasksById = new Map(parsed.tasks.map((task) => [task.id, task]));
  const scores: EvaluationTaskScore[] = [];

  for (const result of results) {
    const task = tasksById.get(result.taskId);
    if (!task) {
      throw new EvaluationSuiteError(
        `Unknown evaluation task id '${result.taskId}' for suite '${parsed.name}'`,
      );
    }
    scores.push(scoreEvaluationTask(task, result.state));
  }

  return aggregateEvaluationScores(scores);
}
