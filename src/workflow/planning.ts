import path from "node:path";
import type { RoleAgentService } from "../agents/service.js";
import { singleTaskPlan } from "../flow/index.js";
import { exploreSummarySchema, taskPlanSchema, type ExploreSummary, type TaskPlan } from "../domain/contracts.js";
import { exploreSummaryJsonSchema, taskPlanJsonSchema } from "../domain/json-schemas.js";
import { mkdir, writeFile } from "node:fs/promises";
import { attachTreeNodes, designIssues, resolveDesign } from "../domain/architecture-design.js";
import { repoIndex } from "../domain/repo-tree.js";
import { assessPlanCompleteness, fallbackHandoverTaskPlan, fallbackNamedTaskPlan, formatPlanCompletenessError, validateTaskPlan } from "../domain/plan.js";
import { type RunStateStore } from "../state/store.js";
import type { RunState } from "../state/types.js";
import { truncateExploreSummary } from "./state-helpers.js";
import type { RunContext, RunnerEnv } from "./types.js";
import type { CheckpointService } from "./checkpoints.js";

interface PlanInput {
  goal: string;
  allowImpliedHandover: boolean;
  intake: NonNullable<RunContext["intake"]>;
  allowedProfiles: string[];
  extra?: Record<string, unknown>;
}

interface Verdict {
  /** Completeness or design problems: the architect tries once more. */
  retry: boolean;
  /** Only a rejected completeness blocks the plan outright. */
  rejected: boolean;
  issues: string[];
}

function judge(plan: TaskPlan, input: PlanInput): Verdict {
  const completeness = assessPlanCompleteness(plan, input.goal, {
    allowImpliedHandover: input.allowImpliedHandover,
  });
  const design = designIssues(plan);
  return {
    retry: completeness.status === "rejected" || design.length > 0,
    rejected: completeness.status === "rejected",
    issues: [...completeness.issues, ...design],
  };
}

export class PlanningStage {
  constructor(
    private readonly env: RunnerEnv,
    private readonly checkpoints: CheckpointService,
  ) {}

  controllerPlan(planningGoal: string, allowImpliedHandover: boolean): TaskPlan | undefined {
    const plan = fallbackNamedTaskPlan(planningGoal);
    if (!plan) return undefined;
    validateTaskPlan(plan);
    const completeness = assessPlanCompleteness(plan, planningGoal, { allowImpliedHandover });
    return completeness.status === "rejected" ? undefined : plan;
  }

  async planStage(context: RunContext, singleTask: boolean): Promise<void> {
    const { state, store, git } = context;
    let plan: TaskPlan;
    let message: string;
    if (context.deterministicPlan) {
      await store.transition(
        state,
        "architecting",
        "目标已写明任务与路径，控制面直接生成 DAG（不调用架构模型）",
      );
      plan = resolveDesign(context.deterministicPlan, "controller");
      message = `Controller produced ${plan.tasks.length} task(s) from the goal`;
    } else if (singleTask) {
      await store.transition(state, "architecting", "快速流程：整个目标作为单个任务（不调用架构模型）");
      plan = resolveDesign(singleTaskPlan(state.goal), "controller");
      message = "Quick flow planned a single task";
    } else {
      plan = await this.architectPlan(context);
      message = `Architect produced ${plan.tasks.length} task(s)`;
    }
    plan = attachTreeNodes(plan, state.repoTree);
    state.plan = plan;
    state.tasks = plan.tasks.map((task) => ({ task, status: "pending", attempts: 0 }));
    await store.transition(state, "planned", message);
    context.planCheckpoint = await this.checkpoints.recordCheckpoint(state, store, git, "plan-ready");
  }

  async architectPlan(context: RunContext): Promise<TaskPlan> {
    const intake = context.intake ?? context.state.intake;
    if (!intake) throw new Error("Architect planning requires goal intake");
    const workerRole = this.env.loaded.config.roles.worker;
    if (!workerRole) throw new Error("Required worker role is missing");
    const input = {
      goal: context.planningGoal ?? context.state.goal,
      allowImpliedHandover: context.allowImpliedHandover ?? false,
      intake,
      allowedProfiles: workerRole.allowedProfiles,
    };
    await context.store.transition(context.state, "architecting", "架构正在产出系统设计并拆分任务");
    const first = await this.runArchitect(context, input, "architecture");
    const verdict = judge(first, input);
    if (!verdict.retry) return resolveDesign(first, "inferred");
    const second = await this.runArchitect(
      context,
      this.retryInput(context, input, first, verdict.issues),
      "architecture-retry",
    );
    return this.settle(context, input, second);
  }

  /** The architect context: same project facts, a longer instruction set on retry. */
  private retryInput(
    context: RunContext,
    input: PlanInput,
    rejected: TaskPlan,
    issues: string[],
  ): PlanInput {
    return {
      ...input,
      intake: {
        ...input.intake,
        instructionsForArchitect: [
          input.intake.instructionsForArchitect,
          `Previous plan was rejected: ${issues.join("；")}.`,
          "Do not emit reconnaissance-only tasks. Produce one implementable task for each named T1–Tn / P0.x deliverable now.",
          "Return design.elements (id, name, kind, responsibility, paths), relations, and sequence.",
          "Every task.elementId must name an element whose paths cover that task's ownedPaths.",
          "A cross-element task dependency needs a depends or calls relation in the same direction.",
        ].join(" "),
      },
      extra: { previousRejectedPlan: rejected, completenessIssues: issues },
    };
  }

  /** A retried plan is accepted unless its completeness is still rejected. */
  private settle(context: RunContext, input: PlanInput, plan: TaskPlan): TaskPlan {
    const verdict = judge(plan, input);
    if (!verdict.rejected) return resolveDesign(plan, "inferred");
    return this.fallbackPlan(input, verdict.issues);
  }

  /** Named fallback first, then the implied-handover plan, else fail loudly. */
  private fallbackPlan(input: PlanInput, issues: string[]): TaskPlan {
    const fallback =
      fallbackNamedTaskPlan(input.goal)
      ?? (input.allowImpliedHandover ? fallbackHandoverTaskPlan() : undefined);
    if (fallback && !judge(fallback, input).rejected) return resolveDesign(fallback, "controller");
    throw new Error(
      formatPlanCompletenessError({
        status: "rejected",
        issues,
      } as unknown as Parameters<typeof formatPlanCompletenessError>[0]),
    );
  }

  private async runArchitect(
    context: RunContext,
    input: PlanInput,
    artifactKey: string,
  ): Promise<TaskPlan> {
    const result = await context.agent.runStructured({
      role: "architect",
      runId: context.state.id,
      artifactKey,
      context: this.architectContext(context, input),
      schema: taskPlanSchema,
      jsonSchema: taskPlanJsonSchema,
    });
    validateTaskPlan(result.value);
    return result.value;
  }

  private architectContext(context: RunContext, input: PlanInput): Record<string, unknown> {
    const { verifiedExperiences, exploreSummary } = context;
    return {
      goal: input.goal,
      intake: input.intake,
      project: this.env.loaded.config.project,
      baseCommit: context.state.baseCommit,
      roleProfiles: input.allowedProfiles,
      ...(verifiedExperiences ? { verifiedExperiences } : {}),
      ...(exploreSummary ? { exploreSummary } : {}),
      ...indexContext(context.state),
      ...input.extra,
    };
  }

  async maybeExplore(
    state: RunState,
    store: RunStateStore,
    agent: RoleAgentService,
    goal: string,
    baseCommit: string,
    verifiedExperiences: unknown,
  ): Promise<ExploreSummary | undefined> {
    const explore = state.strategy.explore;
    if (!explore?.enabled) return undefined;
    const exploreRole = this.env.loaded.config.roles.researcher ? "researcher" : "architect";
    await store.transition(state, "exploring", "技术研究员只读调研代码库（explore）");
    store.emit(state.id, "run.explore.started", this.exploreStartedPayload(state, explore, exploreRole));
    try {
      const result = await agent.runStructured({
        role: exploreRole,
        runId: state.id,
        artifactKey: "explore",
        ...(explore.profile ? { profileName: explore.profile } : {}),
        context: this.exploreContext(state, goal, baseCommit, verifiedExperiences),
        schema: exploreSummarySchema,
        jsonSchema: exploreSummaryJsonSchema,
      });
      return await this.recordExplore(state, store, explore, result);
    } catch (error) {
      return this.exploreFailed(state, store, explore, error);
    }
  }

  private exploreStartedPayload(
    state: RunState,
    explore: NonNullable<RunState["strategy"]["explore"]>,
    role: string,
  ): Record<string, unknown> {
    return {
      role,
      profile:
        explore.profile
        ?? state.strategy.roleProfiles.researcher
        ?? state.strategy.roleProfiles.architect
        ?? null,
      maxInjectedChars: explore.maxInjectedChars,
      failOpen: explore.failOpen,
    };
  }

  private exploreContext(
    state: RunState,
    goal: string,
    baseCommit: string,
    verifiedExperiences: unknown,
  ): Record<string, unknown> {
    return {
      mode: "explore-only",
      goal,
      intake: state.intake,
      project: this.env.loaded.config.project,
      baseCommit,
      instructions: [
        "Read-only technical research before task planning.",
        "Do not propose file edits or commits.",
        "Return a structured summary of modules, risks, and constraints.",
      ],
      ...(verifiedExperiences ? { verifiedExperiences } : {}),
      ...indexContext(state),
    };
  }

  /** Persist the summary, report how much was injected and note the result. */
  private async recordExplore(
    state: RunState,
    store: RunStateStore,
    explore: NonNullable<RunState["strategy"]["explore"]>,
    result: { value: ExploreSummary; profileName: string },
  ): Promise<ExploreSummary> {
    const summary = result.value;
    state.explore = summary;
    const artifactDir = store.artifactDirectory(state.id, "explore");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      path.join(artifactDir, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    );
    const injected = truncateExploreSummary(summary, explore.maxInjectedChars);
    store.emit(state.id, "run.explore.completed", {
      success: true,
      profile: result.profileName,
      injectedChars: JSON.stringify(injected).length,
    });
    await store.transition(
      state,
      "exploring",
      `探索完成：${summary.summary.slice(0, 120)}${summary.summary.length > 120 ? "…" : ""}`,
    );
    return injected;
  }

  /** A failed exploration only stops the run when failOpen is off. */
  private async exploreFailed(
    state: RunState,
    store: RunStateStore,
    explore: NonNullable<RunState["strategy"]["explore"]>,
    error: unknown,
  ): Promise<ExploreSummary | undefined> {
    const message = error instanceof Error ? error.message : String(error);
    store.emit(state.id, "run.explore.completed", {
      success: false,
      error: message,
      failOpen: explore.failOpen,
    });
    if (!explore.failOpen) throw error;
    await store.transition(
      state,
      "exploring",
      `探索失败已跳过（failOpen）：${message.slice(0, 160)}`,
    );
    return undefined;
  }
}

function indexContext(state: RunState): { repoIndex: NonNullable<ReturnType<typeof repoIndex>> } | Record<string, never> {
  const index = repoIndex(state.repoTrace);
  return index ? { repoIndex: index } : {};
}
