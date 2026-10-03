import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { configSchema, type AgentTeamConfig } from "./schema.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { CliInventory } from "../desktop/cli-inventory.js";

const configNames = ["agent-team.yaml", "agent-team.yml"];

export interface LoadedConfig {
  config: AgentTeamConfig;
  path: string;
  root: string;
  /**
   * "file": read from agent-team.yaml. "detected": synthesized in memory from
   * the repository and installed CLIs (zero-config); `path` is where the file
   * would be written once the user customizes.
   */
  source?: "file" | "detected";
}

export interface LoadConfigOptions {
  /**
   * "full"（默认）: 除 schema 校验外，还针对 adapter registry 校验每个 profile
   * 的能力声明，并用 evaluation suite schema 解析 evaluation.suite（快速失败）。
   * 默认路径通过惰性动态导入取得校验器，因此 config 包对 adapters / evaluation
   * 没有静态值依赖；装配点（cli、runtime）也可显式传入 registry 复用实例。
   * "schema-only": 只产出 LoadedConfig，不做上述跨包校验。
   */
  validation?: "full" | "schema-only";
  /** validation: "full" 时复用的 registry；缺省惰性创建一个默认 AdapterRegistry。 */
  registry?: AdapterRegistry;
  /**
   * When no agent-team.yaml exists, synthesize a configuration from the
   * repository (detected quality commands) and installed agent CLIs instead of
   * failing. Nothing is written to disk.
   */
  zeroConfig?: boolean;
  /** CLI inventory used for zero-config adapter selection; scanned lazily if omitted. */
  inventory?: CliInventory;
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

/**
 * Full validation pulls in the adapter registry / conformance checks and the
 * evaluation suite parser. Imported lazily so the config package carries no
 * static value edge to those packages; callers that already assembled a
 * registry can pass it via LoadConfigOptions.registry.
 */
async function validateLoadedConfig(
  config: AgentTeamConfig,
  configPath: string,
  registry?: AdapterRegistry,
): Promise<void> {
  const [{ AdapterRegistry: Registry }, { assertAdapterProfile }, { parseEvaluationSuite }] =
    await Promise.all([
      import("../adapters/registry.js"),
      import("../adapters/conformance.js"),
      import("../evaluation/domain.js"),
    ]);
  const adapters = registry ?? new Registry();

  if (config.evaluation?.suite !== undefined) {
    try {
      config.evaluation.suite = parseEvaluationSuite(config.evaluation.suite);
    } catch (error) {
      throw new Error(
        `Invalid configuration at ${configPath}:\nevaluation.suite: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  for (const [profileName, profile] of Object.entries(config.profiles)) {
    try {
      assertAdapterProfile(adapters.get(profile.adapter), profile, false);
    } catch (error) {
      throw new Error(
        `Invalid configuration at ${configPath}:\nprofiles.${profileName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function scanInventoryOrUndefined(): Promise<CliInventory | undefined> {
  try {
    const { getInventory } = await import("../desktop/settings.js");
    return (await getInventory({ refresh: false })).inventory;
  } catch {
    return undefined;
  }
}

export async function loadConfig(
  startDirectory = process.cwd(),
  explicitPath?: string,
  options: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  const configPath = explicitPath
    ? path.resolve(startDirectory, explicitPath)
    : await findConfig(startDirectory);

  let source: "file" | "detected" = "file";
  let resolvedPath = configPath ?? path.join(startDirectory, "agent-team.yaml");
  let resolvedRoot = configPath ? path.dirname(configPath) : startDirectory;
  let document: unknown;
  if (!configPath) {
    if (!options.zeroConfig) {
      throw new Error("No agent-team.yaml found. Run 'agent-team init' first.");
    }
    const { loadZeroConfig } = await import("../onboarding/starter.js");
    const inventory = options.inventory ?? (await scanInventoryOrUndefined());
    const zero = await loadZeroConfig(startDirectory, inventory ? { inventory } : {});
    document = zero.config;
    resolvedPath = zero.path;
    resolvedRoot = zero.root;
    source = "detected";
  } else {
    document = parseYaml(await readFile(configPath, "utf8"));
  }
  const displayPath = resolvedPath;
  const result = configSchema.safeParse(document);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration at ${displayPath}:\n${details}`);
  }

  const automation = result.data.evolution.automatic;
  if (
    automation.enabled &&
    result.data.strategies?.definitions[automation.targetStrategy]
  ) {
    throw new Error(
      `Invalid configuration at ${displayPath}:\nevolution.automatic.targetStrategy: ` +
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

  if (options.validation !== "schema-only") {
    await validateLoadedConfig(result.data, displayPath, options.registry);
  }

  return {
    config: result.data,
    path: displayPath,
    root: resolvedRoot,
    source,
  };
}
