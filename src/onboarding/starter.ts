import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument, stringify as stringifyYaml } from "yaml";
import { createDefaultConfig } from "../config/defaults.js";
import type { LoadedConfig } from "../config/load.js";
import type { AgentTeamConfig, CommandSpec } from "../config/schema.js";
import type { CliId, CliInventory, CliProbeResult } from "../desktop/cli-inventory.js";
import { detectRepository, resolveGitRoot, selectedCommands, type RepoDetection } from "./detect.js";

/** Preference order when several runnable CLIs are installed. */
const CLI_PRIORITY: CliId[] = ["codex", "claude", "kimi", "grok"];
const FALLBACK_MODEL: Record<CliId, string> = {
  codex: "inherit",
  claude: "sonnet",
  kimi: "kimi-code",
  grok: "grok-4.6",
};
const ROLES = ["orchestrator", "architect", "researcher", "worker", "reviewer", "tester"] as const;

export function pickStarterCli(inventory?: CliInventory): CliProbeResult | undefined {
  if (!inventory) return undefined;
  const usable = inventory.clis.filter((cli) => cli.installed && cli.runtimeSupported);
  for (const id of CLI_PRIORITY) {
    const match = usable.find((cli) => cli.id === id && cli.auth.status !== "missing");
    if (match) return match;
  }
  return usable[0];
}

export interface StarterOptions {
  detection: RepoDetection;
  inventory?: CliInventory;
}

/**
 * Build an in-memory configuration from what the machine and repository
 * already tell us. Nothing here is persisted; `agent-team.yaml` is only
 * written when the user customizes in the UI or runs `agent-team init`.
 */
export function buildStarterConfig(options: StarterOptions): AgentTeamConfig {
  const { detection } = options;
  const config = createDefaultConfig(detection.name);
  config.project.defaultBranch = detection.defaultBranch ?? config.project.defaultBranch;
  config.quality.commands = selectedCommands(detection);

  const cli = pickStarterCli(options.inventory);
  if (cli && cli.id !== "codex") {
    const model = cli.defaultModel ?? FALLBACK_MODEL[cli.id];
    const planner = `${cli.id}-planner`;
    const worker = `${cli.id}-worker`;
    config.profiles = {
      [planner]: {
        adapter: cli.id,
        model,
        reasoning: "high",
        permission: "read-only",
        externalTools: "deny",
        timeoutSeconds: 900,
        args: [],
      },
      [worker]: {
        adapter: cli.id,
        model,
        reasoning: "medium",
        permission: "workspace-write",
        externalTools: "deny",
        timeoutSeconds: 1800,
        args: [],
      },
    };
    for (const role of ROLES) {
      const profile = role === "worker" ? worker : planner;
      config.roles[role] = {
        defaultProfile: profile,
        allowedProfiles: [profile],
        fallbackProfiles: [],
      };
    }
  }
  return config;
}

export interface ZeroConfigOptions {
  inventory?: CliInventory;
}

/**
 * Resolve a LoadedConfig for a directory with no agent-team.yaml. The virtual
 * path points where the file would be written if the user customizes.
 */
export async function loadZeroConfig(
  startDirectory: string,
  options: ZeroConfigOptions = {},
): Promise<{ config: AgentTeamConfig; path: string; root: string; detection: RepoDetection }> {
  const gitRoot = await resolveGitRoot(startDirectory);
  if (!gitRoot) {
    throw new Error(
      `No agent-team.yaml found and ${path.resolve(startDirectory)} is not inside a Git repository. ` +
        "Run inside a Git repository, or run 'agent-team init' first.",
    );
  }
  const detection = await detectRepository(gitRoot);
  const config = buildStarterConfig({
    detection,
    ...(options.inventory ? { inventory: options.inventory } : {}),
  });
  return {
    config,
    path: path.join(gitRoot, "agent-team.yaml"),
    root: gitRoot,
    detection,
  };
}

/**
 * Keep `.agent-team/` out of `git status` for zero-config projects without
 * touching tracked files: the entry goes into the local-only info/exclude.
 */
export async function ensureStateDirectoryExcluded(
  root: string,
  stateDirectory: string,
): Promise<void> {
  const gitDir = path.join(root, ".git");
  const excludePath = path.join(gitDir, "info", "exclude");
  try {
    await mkdir(path.dirname(excludePath), { recursive: true });
  } catch {
    // .git may be a file (worktree/submodule); the exclude hint is best-effort.
    return;
  }
  const entry = `/${stateDirectory.replace(/^\.?\//, "").replace(/\/$/, "")}/`;
  let current = "";
  try {
    current = await readFile(excludePath, "utf8");
  } catch {
    // No exclude file yet.
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === entry)) return;
  const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
  await appendFile(excludePath, `${prefix}${entry}\n`, "utf8");
}

export function serializeStarterConfig(config: AgentTeamConfig): string {
  return stringifyYaml(config);
}

/**
 * Persist the user's quality-command choice. Existing YAML is edited through
 * the document model so comments and unrelated keys survive; a zero-config
 * project gets a fresh file generated from the in-memory starter config.
 */
export async function saveQualityCommands(
  loaded: LoadedConfig,
  commands: CommandSpec[],
): Promise<void> {
  let contents: string | undefined;
  if (loaded.source !== "detected") {
    contents = await readFile(loaded.path, "utf8");
  }
  if (contents === undefined) {
    // The runtime config carries custom strategies merged in from the strategy
    // catalog; the file must only hold the base definitions.
    const next: AgentTeamConfig = {
      ...loaded.config,
      strategies: createDefaultConfig(loaded.config.project.name).strategies,
      quality: { ...loaded.config.quality, commands },
    };
    await writeFile(loaded.path, serializeStarterConfig(next), { encoding: "utf8", flag: "wx" });
  } else {
    const document = parseDocument(contents);
    document.setIn(["quality", "commands"], commands);
    await writeFile(loaded.path, String(document), "utf8");
  }
  loaded.config.quality.commands = commands;
  loaded.source = "file";
}
