/**
 * EvaluationSuite v1 domain: suite contracts, digests, redaction, scoring.
 * Single source of truth for pure evaluation helpers.
 */
export {
  EVALUATION_SUITE_VERSION,
  LEGACY_EVALUATION_ALLOWED_PATHS,
  EvaluationSuiteError,
  EvaluationSuiteValidationError,
  evaluationTaskKindSchema,
  evaluationSuccessModeSchema,
  evaluationTaskIdSchema,
  evaluationTaskSchema,
  evaluationSuiteSchema,
  evaluationSuiteRuntimeSchema,
  parseEvaluationSuite,
  parseEvaluationSuiteRuntime,
  computeSuiteDigest,
  publicSuiteView,
  synthesizeLegacyEvaluationSuite,
  projectEvaluationRun,
  scoreEvaluationTask,
  aggregateEvaluationScores,
  scoreEvaluationSuite,
  type EvaluationTaskKind,
  type EvaluationSuccessMode,
  type EvaluationTask,
  type EvaluationSuite,
  type PublicEvaluationTask,
  type PublicEvaluationSuite,
  type EvaluationRunSnapshot,
  type EvaluationRunProjection,
  type EvaluationTaskScore,
  type EvaluationSuiteAggregate,
} from "./domain.js";

export {
  resolveEvaluationSuite,
  requireEvaluationSuite,
} from "./resolve.js";
