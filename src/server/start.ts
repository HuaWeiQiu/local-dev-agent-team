import type { LoadedConfig } from "../config/load.js";
import { listenControlServer, type ListeningControlServer } from "./http.js";
import { startProjectRuntime } from "./project-runtime.js";
import type { RunSupervisor } from "./supervisor.js";

export interface RunningControlService extends ListeningControlServer {
  supervisor: RunSupervisor;
}

export async function startControlService(
  loaded: LoadedConfig,
  options: { host?: string; port?: number } = {},
): Promise<RunningControlService> {
  const runtime = await startProjectRuntime(loaded);
  let listening: ListeningControlServer | undefined;
  try {
    listening = await listenControlServer(runtime.loaded, runtime.supervisor, {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 4317,
      strategyCatalog: runtime.strategies,
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await listening?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await runtime.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Control service failed to start and clean up",
      );
    }
    throw error;
  }
  return {
    ...listening,
    supervisor: runtime.supervisor,
    close: async () => await closeInOrder([() => listening.close(), () => runtime.close()]),
  };
}

async function closeInOrder(closers: Array<() => Promise<void>>): Promise<void> {
  const errors: unknown[] = [];
  for (const close of closers) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to close control service");
  }
}
