import {
  listenWorkspaceServer,
  type ListeningControlServer,
  type ProjectHttpContext,
} from "../server/http.js";
import { startProjectRuntime, type ProjectRuntime } from "../server/project-runtime.js";
import type { LoadedWorkspace } from "./load.js";

export interface RunningWorkspaceService extends ListeningControlServer {
  projects: ReadonlyMap<string, ProjectRuntime>;
}

export async function startWorkspaceControlService(
  workspace: LoadedWorkspace,
  options: { host?: string; port?: number } = {},
): Promise<RunningWorkspaceService> {
  const runtimes: Array<{ id: string; runtime: ProjectRuntime }> = [];
  try {
    for (const project of workspace.projects) {
      runtimes.push({
        id: project.id,
        runtime: await startProjectRuntime(project.loaded),
      });
    }
  } catch (error) {
    await cleanupAfterFailure(error, runtimes);
  }

  const contexts: ProjectHttpContext[] = runtimes.map(({ id, runtime }) => ({
    id,
    loaded: runtime.loaded,
    supervisor: runtime.supervisor,
    strategies: runtime.strategies,
  }));
  const listening = await listenWorkspaceServer(contexts, {
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 4317,
  }).catch(async (error: unknown) => await cleanupAfterFailure(error, runtimes));

  const projects = new Map(runtimes.map(({ id, runtime }) => [id, runtime]));
  let closePromise: Promise<void> | undefined;
  return {
    ...listening,
    projects,
    close: () => {
      closePromise ??= closeWorkspace(listening, runtimes);
      return closePromise;
    },
  };
}

async function closeWorkspace(
  listening: ListeningControlServer,
  runtimes: Array<{ runtime: ProjectRuntime }>,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await listening.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await closeAll([...runtimes].reverse().map(({ runtime }) => () => runtime.close()));
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to close workspace service");
  }
}

async function cleanupAfterFailure(
  startupError: unknown,
  runtimes: Array<{ runtime: ProjectRuntime }>,
): Promise<never> {
  try {
    await closeAll([...runtimes].reverse().map(({ runtime }) => () => runtime.close()));
  } catch (cleanupError) {
    throw new AggregateError(
      [startupError, cleanupError],
      "Workspace service failed to start and clean up",
    );
  }
  throw startupError;
}

async function closeAll(closers: Array<() => Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(closers.map(async (close) => await close()));
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to close workspace resources");
  }
}
