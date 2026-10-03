import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import type { CliInventory, CliProbeResult } from "../src/desktop/cli-inventory.js";
import { SqliteEventStore } from "../src/events/store.js";
import { detectRepository, selectedCommands } from "../src/onboarding/detect.js";
import {
  buildStarterConfig,
  ensureStateDirectoryExcluded,
  pickStarterCli,
  saveQualityCommands,
} from "../src/onboarding/starter.js";
import { runProcess } from "../src/process/run.js";
import { listenControlServer } from "../src/server/http.js";
import { RunSupervisor } from "../src/server/supervisor.js";

async function tempDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "agent-team-onboarding-"));
}

async function gitInit(directory: string): Promise<void> {
  for (const args of [["init", "-b", "trunk"], ["config", "user.email", "t@example.com"], ["config", "user.name", "t"]]) {
    await runProcess({ command: "git", args, cwd: directory, timeoutMs: 20_000 });
  }
}

function cli(id: CliProbeResult["id"], patch: Partial<CliProbeResult> = {}): CliProbeResult {
  return {
    id,
    installed: true,
    auth: { status: "present" },
    configPaths: [],
    models: [],
    runtimeSupported: true,
    ...patch,
  };
}

function inventory(...clis: CliProbeResult[]): CliInventory {
  return { scannedAt: new Date().toISOString(), home: "/tmp", clis };
}

describe("repository command detection", () => {
  it("reads node scripts with the lockfile's package manager and never builds shell strings", async () => {
    const root = await tempDir();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { check: "tsc --noEmit", lint: "eslint .", test: "vitest run", build: "vite build" } }),
    );
    await writeFile(path.join(root, "pnpm-lock.yaml"), "");
    const detection = await detectRepository(root);
    expect(detection.packageManager).toBe("pnpm");
    expect(detection.ecosystems).toEqual(["node"]);
    expect(detection.commands.map((entry) => [entry.role, entry.selected, entry.command])).toEqual([
      ["typecheck", true, { command: "pnpm", args: ["run", "check"] }],
      ["lint", true, { command: "pnpm", args: ["run", "lint"] }],
      ["test", true, { command: "pnpm", args: ["run", "test"] }],
      ["build", false, { command: "pnpm", args: ["run", "build"] }],
    ]);
    expect(selectedCommands(detection)).toHaveLength(3);
  });

  it("skips the npm placeholder test script and falls back to tsc when only tsconfig exists", async () => {
    const root = await tempDir();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    );
    await writeFile(path.join(root, "tsconfig.json"), "{}");
    const detection = await detectRepository(root);
    expect(detection.packageManager).toBe("npm");
    expect(detection.commands).toEqual([
      expect.objectContaining({
        role: "typecheck",
        command: { command: "npx", args: ["--no-install", "tsc", "--noEmit"] },
      }),
    ]);
  });

  it("detects python, rust and go; unreached make targets add nothing", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, "pyproject.toml"), "[tool.ruff]\n[tool.pytest.ini_options]\n[tool.mypy]\n");
    await writeFile(path.join(root, "Cargo.toml"), "[package]\n");
    await writeFile(path.join(root, "go.mod"), "module x\n");
    await writeFile(path.join(root, "Makefile"), "test:\n\techo hi\nlint:\n\techo hi\n");
    const detection = await detectRepository(root);
    expect(detection.ecosystems).toEqual(["python", "rust", "go"]);
    const labels = detection.commands.map((entry) => entry.label);
    expect(labels).toEqual(expect.arrayContaining(["ruff check", "pytest", "mypy", "cargo check", "cargo test", "go vet", "go test"]));
    expect(detection.commands.find((entry) => entry.label === "cargo clippy")?.selected).toBe(false);
    expect(detection.commands.find((entry) => entry.label === "go build")?.selected).toBe(false);
    expect(detection.commands.some((entry) => entry.label === "make test")).toBe(false);
  });

  it("uses Makefile targets when nothing else provides the role", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, "Makefile"), "test:\n\techo hi\n");
    const detection = await detectRepository(root);
    expect(detection.commands).toEqual([
      expect.objectContaining({ role: "test", command: { command: "make", args: ["test"] } }),
    ]);
  });

  it("reports the git root and current branch", async () => {
    const root = await tempDir();
    await gitInit(root);
    await mkdir(path.join(root, "sub"));
    const detection = await detectRepository(path.join(root, "sub"));
    expect(detection.isGitRepo).toBe(true);
    expect(await realpathOf(detection.root)).toBe(await realpathOf(root));
    expect(detection.defaultBranch).toBe("trunk");
  });
});

async function realpathOf(value: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return await realpath(value);
}

describe("starter configuration", () => {
  const detection = {
    root: "/tmp/demo",
    name: "demo",
    isGitRepo: true,
    defaultBranch: "trunk",
    ecosystems: ["node"],
    commands: [
      { role: "test" as const, label: "t", source: "x", selected: true, command: { command: "pnpm", args: ["run", "test"] } },
      { role: "build" as const, label: "b", source: "x", selected: false, command: { command: "pnpm", args: ["run", "build"] } },
    ],
  };

  it("prefers codex, then claude, and skips CLIs that are missing or unauthenticated", () => {
    expect(pickStarterCli(inventory(cli("claude"), cli("codex")))?.id).toBe("codex");
    expect(pickStarterCli(inventory(cli("codex", { auth: { status: "missing" } }), cli("claude")))?.id).toBe("claude");
    expect(pickStarterCli(inventory(cli("codex", { installed: false }), cli("kimi", { runtimeSupported: false })))).toBeUndefined();
    expect(pickStarterCli(undefined)).toBeUndefined();
  });

  it("keeps the codex defaults and applies detected commands and branch", () => {
    const config = buildStarterConfig({ detection, inventory: inventory(cli("codex")) });
    expect(config.project.name).toBe("demo");
    expect(config.project.defaultBranch).toBe("trunk");
    expect(config.quality.commands).toEqual([{ command: "pnpm", args: ["run", "test"] }]);
    expect(config.roles.worker?.defaultProfile).toBe("codex-worker");
  });

  it("re-points every role at the available CLI when codex is not usable", () => {
    const config = buildStarterConfig({
      detection,
      inventory: inventory(cli("codex", { installed: false }), cli("claude", { defaultModel: "opus" })),
    });
    expect(Object.keys(config.profiles).sort()).toEqual(["claude-planner", "claude-worker"]);
    expect(config.profiles["claude-worker"]).toMatchObject({ adapter: "claude", model: "opus", permission: "workspace-write" });
    expect(config.roles.reviewer?.defaultProfile).toBe("claude-planner");
    expect(config.roles.worker?.allowedProfiles).toEqual(["claude-worker"]);
  });
});

describe("zero-config load", () => {
  it("synthesizes a validated config from the repository without writing agent-team.yaml", async () => {
    const root = await tempDir();
    await gitInit(root);
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const loaded = await loadConfig(root, undefined, {
      zeroConfig: true,
      inventory: inventory(cli("claude")),
    });
    expect(loaded.source).toBe("detected");
    expect(await realpathOf(loaded.root)).toBe(await realpathOf(root));
    expect(path.basename(loaded.path)).toBe("agent-team.yaml");
    expect(loaded.config.quality.commands).toEqual([{ command: "npm", args: ["run", "test"] }]);
    expect(loaded.config.roles.researcher).toBeDefined();
    await expect(readFile(loaded.path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still fails without the option, and outside a git repository", async () => {
    const root = await tempDir();
    await expect(loadConfig(root, undefined, { validation: "schema-only" })).rejects.toThrow(/agent-team init/);
    await expect(
      loadConfig(root, undefined, { zeroConfig: true, inventory: inventory(cli("codex")) }),
    ).rejects.toThrow(/not inside a Git repository/);
  });

  it("prefers an existing agent-team.yaml", async () => {
    const root = await tempDir();
    await gitInit(root);
    const first = await loadConfig(root, undefined, { zeroConfig: true, inventory: inventory(cli("codex")) });
    await saveQualityCommands(first, [{ command: "make", args: ["test"] }]);
    const second = await loadConfig(root, undefined, { zeroConfig: true, inventory: inventory(cli("claude")) });
    expect(second.source).toBe("file");
    expect(second.config.quality.commands).toEqual([{ command: "make", args: ["test"] }]);
    expect(Object.keys(second.config.profiles)).toEqual(["codex-planner", "codex-worker"]);
  });
});

describe("saving customizations", () => {
  it("edits an existing yaml in place and keeps comments", async () => {
    const root = await tempDir();
    await gitInit(root);
    const first = await loadConfig(root, undefined, { zeroConfig: true, inventory: inventory(cli("codex")) });
    await saveQualityCommands(first, []);
    const yamlPath = first.path;
    const original = await readFile(yamlPath, "utf8");
    await writeFile(yamlPath, `# keep me\n${original}`);
    const loaded = await loadConfig(root, undefined, { validation: "schema-only" });
    expect(loaded.source).toBe("file");
    await saveQualityCommands(loaded, [{ command: "pnpm", args: ["run", "lint"] }]);
    const after = await readFile(yamlPath, "utf8");
    expect(after.startsWith("# keep me")).toBe(true);
    expect(after).toContain("lint");
    expect(loaded.config.quality.commands).toEqual([{ command: "pnpm", args: ["run", "lint"] }]);
  });

  it("does not persist runtime strategy merges when writing a fresh file", async () => {
    const root = await tempDir();
    await gitInit(root);
    const loaded = await loadConfig(root, undefined, { zeroConfig: true, inventory: inventory(cli("codex")) });
    loaded.config.strategies = {
      default: "balanced",
      definitions: { ...loaded.config.strategies!.definitions, custom: loaded.config.strategies!.definitions.balanced! },
    };
    await saveQualityCommands(loaded, [{ command: "make", args: ["test"] }]);
    const written = await readFile(loaded.path, "utf8");
    expect(written).toContain("balanced");
    expect(written).not.toContain("custom:");
    expect(loaded.source).toBe("file");
  });

  it("excludes the state directory through .git/info/exclude exactly once", async () => {
    const root = await tempDir();
    await gitInit(root);
    await ensureStateDirectoryExcluded(root, ".agent-team");
    await ensureStateDirectoryExcluded(root, ".agent-team");
    const exclude = await readFile(path.join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((line) => line === "/.agent-team/")).toHaveLength(1);
    await writeFile(path.join(root, "a.txt"), "x");
    await runProcess({ command: "git", args: ["add", "a.txt"], cwd: root, timeoutMs: 10_000 });
    await runProcess({ command: "git", args: ["commit", "-m", "init"], cwd: root, timeoutMs: 10_000 });
    await mkdir(path.join(root, ".agent-team"));
    await writeFile(path.join(root, ".agent-team", "x"), "x");
    const status = await runProcess({ command: "git", args: ["status", "--porcelain"], cwd: root, timeoutMs: 10_000 });
    expect(status.stdout).toBe("");
  });
});

describe("onboarding routes", () => {
  it("reports setup state and writes agent-team.yaml only on save", async () => {
    const root = await tempDir();
    await gitInit(root);
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const loaded = await loadConfig(root, undefined, { zeroConfig: true, inventory: inventory(cli("codex")) });
    await mkdir(path.join(root, ".agent-team"), { recursive: true });
    const events = new SqliteEventStore(path.join(root, ".agent-team", "control.sqlite"), { maxEventsPerRun: 100 });
    const supervisor = new RunSupervisor(loaded, events);
    const staticDirectory = path.join(root, ".agent-team", "web");
    await mkdir(staticDirectory, { recursive: true });
    await writeFile(path.join(staticDirectory, "index.html"), "<main>Agent Team</main>");
    const listening = await listenControlServer(loaded, supervisor, { host: "127.0.0.1", port: 0, staticDirectory });

    const response = await fetch(`${listening.url}/api/onboarding`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body).toMatchObject({
      source: "detected",
      needsSetup: true,
      current: { commands: [{ command: "npm", args: ["run", "test"] }] },
    });
    expect(body.detection.commands[0]).toMatchObject({ role: "test", selected: true });

    const foreign = await fetch(`${listening.url}/api/onboarding/quality`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ commands: [] }),
    });
    expect(foreign.status).toBe(403);
    await expect(readFile(loaded.path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const save = await fetch(`${listening.url}/api/onboarding/quality`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands: [{ command: "make", args: ["verify"] }] }),
    });
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({
      source: "file",
      needsSetup: false,
      current: { commands: [{ command: "make", args: ["verify"] }] },
    });
    expect(await readFile(loaded.path, "utf8")).toContain("verify");

    await listening.close();
    await supervisor.close();
    events.close();
  }, 60_000);
});
