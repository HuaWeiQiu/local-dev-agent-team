import path from "node:path";
import type { LoadedConfig } from "../config/load.js";
import { SqliteEventStore } from "../events/store.js";
import { EvolutionApplicationCoordinator } from "../evolution/application.js";
import { DurableEvolutionCatalog } from "../evolution/persistence.js";
import { GitManager } from "../git/manager.js";
import { StrategyBlueprintCatalog } from "../strategies/catalog.js";
import { EvolutionProjectService } from "./evolution-service.js";
import { reapOrphanAgentProcesses } from "../process/live-children.js";
import { acquireControlLease } from "./lease.js";
import { RunSupervisor } from "./supervisor.js";

export interface ProjectRuntime {
  loaded: LoadedConfig;
  strategies: StrategyBlueprintCatalog;
  supervisor: RunSupervisor;
  evolution: EvolutionProjectService;
  close(): Promise<void>;
}

export async function startProjectRuntime(loaded: LoadedConfig): Promise<ProjectRuntime> {
  const stateRoot = path.resolve(loaded.root, loaded.config.project.stateDirectory);
  const lease = await acquireControlLease(stateRoot);
  let strategies: StrategyBlueprintCatalog | undefined;
  let events: SqliteEventStore | undefined;
  let supervisor: RunSupervisor | undefined;
  let evolution: EvolutionProjectService | undefined;
  try {
    strategies = await StrategyBlueprintCatalog.open(loaded);
    loaded = strategies.loaded;
    events = new SqliteEventStore(path.join(stateRoot, "control.sqlite"), {
      maxEventsPerRun: loaded.config.observability.maxEventsPerRun,
    });
    supervisor = new RunSupervisor(loaded, events);
    await supervisor.reconcileInterruptedRuns();
    const swept = await supervisor.reconcileUnknownWorktrees();
    if (swept.removedDirectories.length > 0) {
      console.warn(
        `[agent-team] removed ${swept.removedDirectories.length} worktree director${
          swept.removedDirectories.length === 1 ? "y" : "ies"
        } and ${swept.removedBranches} branch${
          swept.removedBranches === 1 ? "" : "es"
        } left behind by deleted runs`,
      );
    }
    const orphans = await reapOrphanAgentProcesses({
      stateRoot,
      worktreesRoot: path.join(stateRoot, "worktrees"),
    });
    if (orphans.killed.length > 0) {
      console.warn(
        `[agent-team] reaped ${orphans.killed.length} leftover agent ${
          orphans.killed.length === 1 ? "process" : "processes"
        } after a previous control-service stop`,
      );
    }

    const catalog = await DurableEvolutionCatalog.open(loaded);
    const coordinator = await EvolutionApplicationCoordinator.open({
      catalog,
      strategies,
      git: new GitManager(loaded.root, path.join(stateRoot, "worktrees")),
      loaded,
      assertQuiescent: () => supervisor!.assertEvolutionQuiescent(),
    });
    evolution = new EvolutionProjectService(loaded, coordinator, supervisor, strategies);
    await evolution.initialize();

    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= closeRuntime(supervisor!, events!, evolution!, lease, loaded);
      return closePromise;
    };
    return { loaded, strategies, supervisor, evolution, close };
  } catch (error) {
    const cleanupErrors = await cleanupRuntime(supervisor, events, lease, evolution);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Project runtime failed to initialize and clean up",
      );
    }
    throw error;
  }
}

async function closeRuntime(
  supervisor: RunSupervisor,
  events: SqliteEventStore,
  evolution: EvolutionProjectService,
  lease: Awaited<ReturnType<typeof acquireControlLease>>,
  loaded: LoadedConfig,
): Promise<void> {
  const errors = await cleanupRuntime(supervisor, events, lease, evolution);
  if (errors.length > 0) {
    throw new AggregateError(errors, `Failed to close project runtime '${loaded.config.project.name}'`);
  }
}

async function cleanupRuntime(
  supervisor: RunSupervisor | undefined,
  events: SqliteEventStore | undefined,
  lease: Awaited<ReturnType<typeof acquireControlLease>>,
  evolution?: EvolutionProjectService,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  if (evolution) {
    try {
      await evolution.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (supervisor) {
    try {
      await supervisor.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (events) {
    try {
      events.close();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await lease.release();
  } catch (error) {
    errors.push(error);
  }
  return errors;
}
