import path from "node:path";
import type { LoadedConfig } from "../config/load.js";
import { SqliteEventStore } from "../events/store.js";
import { StrategyBlueprintCatalog } from "../strategies/catalog.js";
import { acquireControlLease } from "./lease.js";
import { RunSupervisor } from "./supervisor.js";

export interface ProjectRuntime {
  loaded: LoadedConfig;
  strategies: StrategyBlueprintCatalog;
  supervisor: RunSupervisor;
  close(): Promise<void>;
}

export async function startProjectRuntime(loaded: LoadedConfig): Promise<ProjectRuntime> {
  const stateRoot = path.resolve(loaded.root, loaded.config.project.stateDirectory);
  const lease = await acquireControlLease(stateRoot);
  let strategies: StrategyBlueprintCatalog;
  try {
    strategies = await StrategyBlueprintCatalog.open(loaded);
    loaded = strategies.loaded;
  } catch (error) {
    try {
      await lease.release();
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], "Strategy catalog failed to open");
    }
    throw error;
  }
  let events: SqliteEventStore;
  try {
    events = new SqliteEventStore(path.join(stateRoot, "control.sqlite"), {
      maxEventsPerRun: loaded.config.observability.maxEventsPerRun,
    });
  } catch (error) {
    try {
      await lease.release();
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], "Project event store failed to open");
    }
    throw error;
  }
  let supervisor: RunSupervisor;
  try {
    supervisor = new RunSupervisor(loaded, events);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      events.close();
    } catch (closeError) {
      cleanupErrors.push(closeError);
    }
    try {
      await lease.release();
    } catch (releaseError) {
      cleanupErrors.push(releaseError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Project supervisor failed to initialize",
      );
    }
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= closeRuntime();
    return closePromise;
  };
  const closeRuntime = async (): Promise<void> => {
    const errors: unknown[] = [];
    try {
      await supervisor.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      events.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await lease.release();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to close project runtime '${loaded.config.project.name}'`);
    }
  };
  try {
    await supervisor.reconcileInterruptedRuns();
  } catch (error) {
    try {
      await close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Project runtime failed to start and close");
    }
    throw error;
  }
  return { loaded, strategies, supervisor, close };
}
