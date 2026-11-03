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
    const { state, store, git } = context;
    const finalQuality = state.finalQuality;
    if (!finalQuality) throw new Error("Final decision requires integration quality results");
    const decision = deterministic
      ? deterministicDecision(finalQuality.passed)
      : await this.modelDecision(context, finalQuality);
    state.finalDecision = decision;
    const mergedTasks = state.tasks.filter((task) => task.status === "merged");
    const qualityPassedWithMergedWork = finalQuality.passed && mergedTasks.length > 0;
    this.assertDecisionAccepted({ finalQuality, decision, qualityPassedWithMergedWork });
    this.recordDowngrade(state, decision, mergedTasks, qualityPassedWithMergedWork);
    context.finalCheckpoint = await this.checkpoints.recordCheckpoint(state, store, git, "local-gates-passed");
  }

  private async modelDecision(context: RunContext, finalQuality: NonNullable<RunContext["state"]["finalQuality"]>) {
    const { state, agent } = context;
    const preFinalAdvice = context.preFinalAdvice;
    const finalDecision = await agent.runStructured({
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
    return finalDecision.value;
  }

  /** A failure always wins; an escalate only stands when nothing merged yet. */
  private assertDecisionAccepted(input: {
    finalQuality: NonNullable<RunContext["state"]["finalQuality"]>;
    decision: { decision: string; reason: string };
    qualityPassedWithMergedWork: boolean;
  }): void {
    const { finalQuality, decision, qualityPassedWithMergedWork } = input;
    const accepted =
      finalQuality.passed && (decision.decision === "ready" || qualityPassedWithMergedWork);
    if (accepted) return;
    if (!finalQuality.passed) {
      throw new Error(formatQualityFailure("Integration quality commands failed", finalQuality));
    }
    throw new Error(`Supervising agent escalated: ${decision.reason}`);
  }

  private recordDowngrade(
    state: RunContext["state"],
    decision: { decision: string; reason: string },
    mergedTasks: RunContext["state"]["tasks"],
    qualityPassedWithMergedWork: boolean,
  ): void {
    if (!qualityPassedWithMergedWork || decision.decision === "ready") return;
    state.history.push({
      at: new Date().toISOString(),
      status: "final-checks",
      message: `终裁 escalate 已降级：质量门已过且 ${mergedTasks.map((task) => task.task.id).join(", ")} 已合并。${decision.reason}`,
    });
  }
}

/** The quick flow has no model decision: the gates decide. */
function deterministicDecision(passed: boolean) {
  return passed
    ? { decision: "ready" as const, reason: "Integration quality commands passed (quick flow has no model decision)" }
    : { decision: "escalate" as const, reason: "Integration quality commands failed" };
}
