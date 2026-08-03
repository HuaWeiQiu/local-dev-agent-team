import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { configSchema, type AgentTeamConfig } from "./schema.js";

const configNames = ["agent-team.yaml", "agent-team.yml"];

export interface LoadedConfig {
  config: AgentTeamConfig;
  path: string;
  root: string;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function findConfig(startDirectory: string): Promise<string | undefined> {
  let current = path.resolve(startDirectory);
  while (true) {
    for (const name of configNames) {
      const candidate = path.join(current, name);
      if (await exists(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export async function loadConfig(
  startDirectory = process.cwd(),
  explicitPath?: string,
): Promise<LoadedConfig> {
  const configPath = explicitPath
    ? path.resolve(startDirectory, explicitPath)
    : await findConfig(startDirectory);

  if (!configPath) {
    throw new Error("No agent-team.yaml found. Run 'agent-team init' first.");
  }

  const contents = await readFile(configPath, "utf8");
  const document = parseYaml(contents);
  const result = configSchema.safeParse(document);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration at ${configPath}:\n${details}`);
  }

  return {
    config: result.data,
    path: configPath,
    root: path.dirname(configPath),
  };
}
