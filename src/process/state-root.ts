import path from "node:path";

/**
 * Resolve the project `.agent-team` directory that owns live-child ledgers.
 * Prefer `cwd` when it already sits under a managed worktree; otherwise fall
 * back to `AGENT_TEAM_STATE_ROOT` set by the control service, then cwd.
 */
export function resolveAgentTeamStateRoot(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromCwd = stateRootFromPath(cwd);
  if (fromCwd) {
    return fromCwd;
  }
  const fromEnv = env.AGENT_TEAM_STATE_ROOT;
  if (fromEnv && fromEnv.length > 0) {
    return path.resolve(fromEnv);
  }
  return path.resolve(cwd, ".agent-team");
}

function stateRootFromPath(target: string): string | undefined {
  const resolved = path.resolve(target);
  const marker = `${path.sep}.agent-team${path.sep}`;
  const index = resolved.lastIndexOf(marker);
  if (index === -1) {
    if (path.basename(resolved) === ".agent-team") {
      return resolved;
    }
    return undefined;
  }
  return resolved.slice(0, index + marker.length - 1);
}
