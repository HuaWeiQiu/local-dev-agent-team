import os from "node:os";
import path from "node:path";

/** Software-wide experience root (shared across projects). */
export function defaultExperienceHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENT_TEAM_HOME?.trim() || env.AGENT_TEAM_EXPERIENCE_HOME?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".agent-team");
}

export function sharedExperienceCatalogPath(
  env: NodeJS.ProcessEnv = process.env,
  sharedDirectory?: string,
): string {
  if (sharedDirectory?.trim()) {
    return path.join(path.resolve(sharedDirectory.trim()), "catalog.json");
  }
  return path.join(defaultExperienceHome(env), "experience", "shared", "catalog.json");
}

export function projectExperienceCatalogPath(stateRoot: string): string {
  return path.join(stateRoot, "experience", "catalog.json");
}
