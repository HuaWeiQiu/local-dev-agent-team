import { finalDecisionSchema } from "../domain/contracts.js";
import { finalDecisionJsonSchema } from "../domain/json-schemas.js";
import { formatQualityFailure } from "../quality/install.js";
import { recoveryArtifactKey } from "./state-helpers.js";
import { compactQuality } from "./verdict-policy.js";
import type { RunContext, RunnerEnv } from "./types.js";
import type { CheckpointService } from "./checkpoints.js";

export class DecisionStage {
  constructor(
    private readonly env: RunnerEnv,
    private readonly checkpoints: CheckpointService,
  ) {}

  async decideStage(context: RunContext, deterministic: boolean): Promise<void> {
    const { state, store, git, agent } = context;
    const finalQuality = state.finalQuality;
    if (!finalQuality) throw new Error("Final decision requires integration quality results");
    const preFinalAdvice = context.preFinalAdvice;
    const finalDecision = deterministic
      ? {
          value: finalQuality.passed
            ? { decision: "ready" as const, reason: "Integration quality commands passed (quick flow has no model decision)" }
            : { decision: "escalate" as const, reason: "Integration quality commands failed" },
        }
      : await agent.runStructured({
          role: "orchestrator",
          promptKey: "orchestrator-final",
          cwd: state.integrationWorktree,
          runId: state.id,
          artifactKey: recoveryArtifactKey(state, "final-decision"),
          context: {
            goal: state.goal,
            planSummary: state.plan?.summary,
            tasks: state.tasks.map((task) => ({
              id: task.task.id,
              status: task.status,
              qualityPassed: task.quality?.passed,
              review: task.review,
              test: task.test,
            })),
            finalQuality: compactQuality(finalQuality),
            ...(preFinalAdvice ? { preFinalAdvice } : {}),
          },
          schema: finalDecisionSchema,
          jsonSchema: finalDecisionJsonSchema,
        });
    state.finalDecision = finalDecision.value;

    const mergedTasks = state.tasks.filter((task) => task.status === "merged");
    const qualityPassedWithMergedWork = finalQuality.passed && mergedTasks.length > 0;
    if (!finalQuality.passed || (finalDecision.value.decision !== "ready" && !qualityPassedWithMergedWork)) {
      throw new Error(
        !finalQuality.passed
          ? formatQualityFailure("Integration quality commands failed", finalQuality)
          : `Supervising agent escalated: ${finalDecision.value.reason}`,
      );
    }
    if (qualityPassedWithMergedWork && finalDecision.value.decision !== "ready") {
      state.history.push({
        at: new Date().toISOString(),
        status: "final-checks",
        message: `终裁 escalate 已降级：质量门已过且 ${mergedTasks.map((task) => task.task.id).join(", ")} 已合并。${finalDecision.value.reason}`,
      });
    }
    context.finalCheckpoint = await this.checkpoints.recordCheckpoint(state, store, git, "local-gates-passed");
  }
}
