import path from "node:path";
import type { RoleAgentService } from "../agents/service.js";
import { singleTaskPlan } from "../flow/index.js";
import { exploreSummarySchema, taskPlanSchema, type ExploreSummary, type TaskPlan } from "../domain/contracts.js";
import { exploreSummaryJsonSchema, taskPlanJsonSchema } from "../domain/json-schemas.js";
import { mkdir, writeFile } from "node:fs/promises";
import { assessPlanCompleteness, fallbackHandoverTaskPlan, fallbackNamedTaskPlan, formatPlanCompletenessError, validateTaskPlan } from "../domain/plan.js";
import { type RunStateStore } from "../state/store.js";
import type { RunState } from "../state/types.js";
import { truncateExploreSummary } from "./state-helpers.js";
import type { RunContext, RunnerEnv } from "./types.js";
import type { CheckpointService } from "./checkpoints.js";

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
      plan = context.deterministicPlan;
      message = `Controller produced ${plan.tasks.length} task(s) from the goal`;
    } else if (singleTask) {
      await store.transition(state, "architecting", "快速流程：整个目标作为单个任务（不调用架构模型）");
      plan = singleTaskPlan(state.goal);
      message = "Quick flow planned a single task";
    } else {
      plan = await this.architectPlan(context);
      message = `Architect produced ${plan.tasks.length} task(s)`;
    }
    state.plan = plan;
    state.tasks = plan.tasks.map((task) => ({ task, status: "pending", attempts: 0 }));
    await store.transition(state, "planned", message);
    context.planCheckpoint = await this.checkpoints.recordCheckpoint(state, store, git, "plan-ready");
  }

  async architectPlan(context: RunContext): Promise<TaskPlan> {
    const { state, store, agent } = context;
    const planningGoal = context.planningGoal ?? state.goal;
    const allowImpliedHandover = context.allowImpliedHandover ?? false;
    const { verifiedExperiences, exploreSummary } = context;
    const intake = context.intake ?? state.intake;
    if (!intake) throw new Error("Architect planning requires goal intake");
    await store.transition(state, "architecting", "架构正在拆分任务 DAG（plan）");
    const workerRole = this.env.loaded.config.roles.worker;
    if (!workerRole) {
      throw new Error("Required worker role is missing");
    }
    let architecture = await agent.runStructured({
      role: "architect",
      runId: state.id,
      artifactKey: "architecture",
      context: {
        goal: planningGoal,
        intake,
        project: this.env.loaded.config.project,
        baseCommit: state.baseCommit,
        roleProfiles: workerRole.allowedProfiles,
        ...(verifiedExperiences ? { verifiedExperiences } : {}),
        ...(exploreSummary ? { exploreSummary } : {}),
      },
      schema: taskPlanSchema,
      jsonSchema: taskPlanJsonSchema,
    });
    validateTaskPlan(architecture.value);
    let completeness = assessPlanCompleteness(architecture.value, planningGoal, { allowImpliedHandover });
    if (completeness.status === "rejected") {
      architecture = await agent.runStructured({
        role: "architect",
        runId: state.id,
        artifactKey: "architecture-retry",
        context: {
          goal: planningGoal,
          intake: {
            ...intake,
            instructionsForArchitect: [
              intake.instructionsForArchitect,
              `Previous plan was rejected: ${completeness.issues.join("；")}.`,
              "Do not emit reconnaissance-only tasks. Produce one implementable task for each named T1–Tn / P0.x deliverable now.",
            ].join(" "),
          },
          project: this.env.loaded.config.project,
          baseCommit: state.baseCommit,
          roleProfiles: workerRole.allowedProfiles,
          previousRejectedPlan: architecture.value,
          completenessIssues: completeness.issues,
          ...(verifiedExperiences ? { verifiedExperiences } : {}),
          ...(exploreSummary ? { exploreSummary } : {}),
        },
        schema: taskPlanSchema,
        jsonSchema: taskPlanJsonSchema,
      });
      validateTaskPlan(architecture.value);
      completeness = assessPlanCompleteness(architecture.value, planningGoal, { allowImpliedHandover });
    }
    if (completeness.status === "rejected") {
      const fallback =
        fallbackNamedTaskPlan(planningGoal)
        ?? (allowImpliedHandover ? fallbackHandoverTaskPlan() : undefined);
      const fallbackReport = fallback
        ? assessPlanCompleteness(fallback, planningGoal, { allowImpliedHandover })
        : undefined;
      if (fallback && fallbackReport && fallbackReport.status !== "rejected") {
        return fallback;
      }
      throw new Error(formatPlanCompletenessError(completeness));
    }
    return architecture.value;
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
    if (!explore?.enabled) {
      return undefined;
    }

    await store.transition(state, "exploring", "技术研究员只读调研代码库（explore）");
    const exploreRole = this.env.loaded.config.roles.researcher ? "researcher" : "architect";
    store.emit(state.id, "run.explore.started", {
      role: exploreRole,
      profile:
        explore.profile
        ?? state.strategy.roleProfiles.researcher
        ?? state.strategy.roleProfiles.architect
        ?? null,
      maxInjectedChars: explore.maxInjectedChars,
      failOpen: explore.failOpen,
    });

    try {
      const result = await agent.runStructured({
        role: exploreRole,
        runId: state.id,
        artifactKey: "explore",
        ...(explore.profile ? { profileName: explore.profile } : {}),
        context: {
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
        },
        schema: exploreSummarySchema,
        jsonSchema: exploreSummaryJsonSchema,
      });

      const summary = result.value;
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.emit(state.id, "run.explore.completed", {
        success: false,
        error: message,
        failOpen: explore.failOpen,
      });
      if (explore.failOpen) {
        await store.transition(
          state,
          "exploring",
          `探索失败已跳过（failOpen）：${message.slice(0, 160)}`,
        );
        return undefined;
      }
      throw error;
    }
  }
}
