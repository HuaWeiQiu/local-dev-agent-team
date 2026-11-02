import type { LoadedConfig } from "../config/load.js";
import { listenControlServer, type ListeningControlServer } from "./http.js";
import { startProjectRuntime, type ProjectRuntime } from "./project-runtime.js";
import type { EvolutionProjectService } from "./evolution-service.js";
import type { RunSupervisor } from "./supervisor.js";

export interface RunningControlService extends ListeningControlServer {
  supervisor: RunSupervisor;
  evolution: EvolutionProjectService;
}

type StartOptions = { host?: string; port?: number; sessionToken?: string };

/**
 * Closes everything it is given and reports what failed instead of stopping at
 * the first failure: a stuck listener must not keep the runtime open.
 */
async function closeAllQuietly(closers: Array<() => Promise<void>>): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const close of closers) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function listenOptions(runtime: ProjectRuntime, options: StartOptions) {
  return {
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 4317,
    strategyCatalog: runtime.strategies,
    evolutionService: runtime.evolution,
    ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
  };
}

/** Keeps the start failure primary and appends whatever the cleanup could not do. */
function startFailure(error: unknown, cleanupErrors: unknown[]): unknown {
  if (cleanupErrors.length === 0) return error;
  return new AggregateError(
    [error, ...cleanupErrors],
    "Control service failed to start and clean up",
  );
}

function closeService(
  listening: ListeningControlServer,
  runtime: ProjectRuntime,
): () => Promise<void> {
  return async () => {
    const errors = await closeAllQuietly([() => listening.close(), () => runtime.close()]);
    if (errors.length > 0) throw new AggregateError(errors, "Failed to close control service");
  };
}

function runningService(
  listening: ListeningControlServer,
  runtime: ProjectRuntime,
): RunningControlService {
  return {
    ...listening,
    supervisor: runtime.supervisor,
    evolution: runtime.evolution,
    close: closeService(listening, runtime),
  };
}

export async function startControlService(
  loaded: LoadedConfig,
  options: StartOptions = {},
): Promise<RunningControlService> {
  const runtime = await startProjectRuntime(loaded);
  try {
    const listening = await listenControlServer(
      runtime.loaded,
      runtime.supervisor,
      listenOptions(runtime, options),
    );
    return runningService(listening, runtime);
  } catch (error) {
    // Nothing bound, so only the runtime needs closing.
    throw startFailure(error, await closeAllQuietly([() => runtime.close()]));
  }
}
