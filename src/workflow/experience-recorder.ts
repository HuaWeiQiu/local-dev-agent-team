import type { LoadedConfig } from "../config/load.js";
import type { RepoTrace } from "../domain/repo-tree.js";
import { ExperienceService } from "../experience/service.js";
import type { RunStateStore } from "../state/store.js";
import type { RunState, TaskRunState } from "../state/types.js";

/**
 * Best-effort bridge between a workflow run and the experience library.
 * Every method swallows failures into an event: experience capture must never
 * change a run's outcome.
 */
export class RunExperienceRecorder {
  constructor(private readonly loaded: LoadedConfig) {}

  async loadPlanning(
    goal: string,
    store: RunStateStore,
    runId: string,
    trace?: RepoTrace,
  ): Promise<Awaited<ReturnType<ExperienceService["retrieveForPlanning"]>>> {
    try {
      const service = ExperienceService.forLoaded(this.loaded);
      const bundle = await service.retrieveForPlanning(goal, { ...(trace ? { trace } : {}) });
      if (bundle) {
        store.emit(runId, "experience.retrieved", {
          purpose: "planning",
          count: bundle.items.length,
          scopes: {
            shared: bundle.items.filter((item) => item.scope === "shared").length,
            project: bundle.items.filter((item) => item.scope === "project").length,
          },
        });
      }
      return bundle;
    } catch (error) {
      store.emit(runId, "experience.retrieve-failed", {
        purpose: "planning",
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async loadRework(
    state: RunState,
    store: RunStateStore,
    input: { feedback: string; taskId: string; taskTitle: string },
  ): Promise<Awaited<ReturnType<ExperienceService["retrieveForRework"]>>> {
    try {
      const service = ExperienceService.forLoaded(this.loaded);
      const bundle = await service.retrieveForRework({
        feedback: input.feedback,
        taskId: input.taskId,
        taskTitle: input.taskTitle,
        limit: 5,
        ...(state.repoTrace ? { trace: state.repoTrace } : {}),
      });
      if (bundle) {
        store.emit(state.id, "experience.retrieved", {
          purpose: "rework",
          taskId: input.taskId,
          count: bundle.items.length,
        });
      }
      return bundle;
    } catch (error) {
      store.emit(state.id, "experience.retrieve-failed", {
        purpose: "rework",
        taskId: input.taskId,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async extractFromRun(
    state: RunState,
    store: RunStateStore,
  ): Promise<void> {
    try {
      const service = ExperienceService.forLoaded(this.loaded);
      const { created, autoPromoted } = await service.extractFromRun(state);
      if (created.length > 0) {
        store.emit(state.id, "experience.extracted", {
          count: created.length,
          ids: created.map((entry) => entry.id),
          autoPromoted: autoPromoted.map((entry) => entry.id),
        });
      }
    } catch (error) {
      store.emit(state.id, "experience.extract-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async recordAttempt(
    state: RunState,
    store: RunStateStore,
    taskState: TaskRunState,
    attempt: number,
    feedback: string,
  ): Promise<void> {
    try {
      const service = ExperienceService.forLoaded(this.loaded);
      const card = await service.recordAttempt({
        runId: state.id,
        taskId: taskState.task.id,
        taskTitle: taskState.task.title,
        attempt,
        feedback,
      });
      if (card) {
        store.emit(state.id, "experience.attempt-recorded", {
          taskId: card.taskId,
          attempt: card.attempt,
          signature: card.signature,
        });
      }
    } catch (error) {
      store.emit(state.id, "experience.attempt-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async recordSuccess(
    state: RunState,
    store: RunStateStore,
    experienceIds: string[],
  ): Promise<void> {
    try {
      const service = ExperienceService.forLoaded(this.loaded);
      const updated = await service.recordSuccess(experienceIds);
      if (updated > 0) {
        store.emit(state.id, "experience.success-recorded", {
          count: updated,
          ids: experienceIds,
        });
      }
    } catch (error) {
      store.emit(state.id, "experience.success-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
