import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { configSchema, type AgentTeamConfig } from "./schema.js";
import { AdapterRegistry } from "../adapters/registry.js";
import { assertAdapterProfile } from "../adapters/conformance.js";
import { parseEvaluationSuite } from "../evaluation/domain.js";

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
  registry = new AdapterRegistry(),
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

  const automation = result.data.evolution.automatic;
  if (
    automation.enabled &&
    result.data.strategies?.definitions[automation.targetStrategy]
  ) {
    throw new Error(
      `Invalid configuration at ${configPath}:\nevolution.automatic.targetStrategy: ` +
      "Automatic evolution target cannot replace a configured strategy",
    );
  }

  // 可选角色缺省补齐：老项目 yaml 没有 researcher 时，镜像 architect（同为只读角色）
  // 的 profile 链，prompt 走内置 prompts/researcher.md，无需改项目文件。
  if (!result.data.roles.researcher) {
    const architect = result.data.roles.architect!;
    result.data.roles.researcher = {
      defaultProfile: architect.defaultProfile,
      allowedProfiles: [...architect.allowedProfiles],
      fallbackProfiles: [...architect.fallbackProfiles],
    };
  }

  if (result.data.evaluation?.suite !== undefined) {
    try {
      result.data.evaluation.suite = parseEvaluationSuite(result.data.evaluation.suite);
    } catch (error) {
      throw new Error(
        `Invalid configuration at ${configPath}:\nevaluation.suite: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  for (const [profileName, profile] of Object.entries(result.data.profiles)) {
    try {
      assertAdapterProfile(registry.get(profile.adapter), profile, false);
    } catch (error) {
      throw new Error(
        `Invalid configuration at ${configPath}:\nprofiles.${profileName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    config: result.data,
    path: configPath,
    root: path.dirname(configPath),
  };
}
