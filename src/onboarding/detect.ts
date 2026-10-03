import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { CommandSpec } from "../domain/commands.js";
import { runProcess } from "../process/run.js";

export type CheckRole = "typecheck" | "lint" | "test" | "build";

export interface DetectedCommand {
  role: CheckRole;
  label: string;
  command: CommandSpec;
  /** Where the command was discovered, e.g. "package.json scripts.test". */
  source: string;
  /** Pre-selected as a deterministic quality gate in the starter config. */
  selected: boolean;
}

export interface RepoDetection {
  root: string;
  name: string;
  isGitRepo: boolean;
  defaultBranch?: string;
  ecosystems: string[];
  packageManager?: string;
  commands: DetectedCommand[];
}

const ROLE_ORDER: CheckRole[] = ["typecheck", "lint", "test", "build"];
const NO_TEST_PLACEHOLDER = /no test specified/i;

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readText(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await runProcess({ command: "git", args, cwd, timeoutMs: 10_000 });
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Git work-tree root containing `directory`, or undefined outside a repository. */
export async function resolveGitRoot(directory: string): Promise<string | undefined> {
  const top = await git(directory, ["rev-parse", "--show-toplevel"]);
  return top ? path.resolve(top) : undefined;
}

async function detectDefaultBranch(root: string): Promise<string | undefined> {
  const remoteHead = await git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead) {
    return remoteHead.replace(/^origin\//, "");
  }
  return await git(root, ["symbolic-ref", "--short", "HEAD"]);
}

async function detectPackageManager(
  root: string,
  manifest: { packageManager?: unknown },
): Promise<string> {
  if (await exists(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(root, "yarn.lock"))) return "yarn";
  if ((await exists(path.join(root, "bun.lockb"))) || (await exists(path.join(root, "bun.lock")))) {
    return "bun";
  }
  if (await exists(path.join(root, "package-lock.json"))) return "npm";
  if (typeof manifest.packageManager === "string") {
    const declared = manifest.packageManager.split("@")[0];
    if (declared === "pnpm" || declared === "yarn" || declared === "bun" || declared === "npm") {
      return declared;
    }
  }
  return "npm";
}

interface Collector {
  add(command: DetectedCommand): void;
  has(role: CheckRole): boolean;
}

function createCollector(): Collector & { list: DetectedCommand[] } {
  const list: DetectedCommand[] = [];
  return {
    list,
    add: (command) => {
      list.push(command);
    },
    has: (role) => list.some((entry) => entry.role === role && entry.selected),
  };
}

async function detectNode(root: string, out: Collector): Promise<string | undefined> {
  const text = await readText(path.join(root, "package.json"));
  if (text === undefined) return undefined;
  let manifest: { scripts?: Record<string, unknown>; packageManager?: unknown } = {};
  try {
    manifest = JSON.parse(text) as typeof manifest;
  } catch {
    return undefined;
  }
  const scripts = Object.fromEntries(
    Object.entries(manifest.scripts ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const pm = await detectPackageManager(root, manifest);
  const run = (script: string): CommandSpec => ({ command: pm, args: ["run", script] });

  const pick = (role: CheckRole, names: string[], selected: boolean): boolean => {
    for (const name of names) {
      const body = scripts[name];
      if (body === undefined) continue;
      if (role === "test" && NO_TEST_PLACEHOLDER.test(body)) continue;
      out.add({
        role,
        label: `${pm} run ${name}`,
        command: run(name),
        source: `package.json scripts.${name}`,
        selected,
      });
      return true;
    }
    return false;
  };

  const typed = pick("typecheck", ["typecheck", "type-check", "check-types", "tsc"], true);
  if (!typed) {
    const hasTsconfig = await exists(path.join(root, "tsconfig.json"));
    if (!pick("typecheck", ["check"], true) && hasTsconfig) {
      const exec: CommandSpec =
        pm === "pnpm"
          ? { command: "pnpm", args: ["exec", "tsc", "--noEmit"] }
          : pm === "yarn"
            ? { command: "yarn", args: ["tsc", "--noEmit"] }
            : pm === "bun"
              ? { command: "bunx", args: ["tsc", "--noEmit"] }
              : { command: "npx", args: ["--no-install", "tsc", "--noEmit"] };
      out.add({
        role: "typecheck",
        label: [exec.command, ...exec.args].join(" "),
        command: exec,
        source: "tsconfig.json",
        selected: true,
      });
    }
  }
  pick("lint", ["lint"], true);
  pick("test", ["test", "test:unit"], true);
  pick("build", ["build"], false);
  return pm;
}

async function detectPython(root: string, out: Collector): Promise<boolean> {
  const pyproject = await readText(path.join(root, "pyproject.toml"));
  const markers = [
    pyproject !== undefined,
    await exists(path.join(root, "setup.py")),
    await exists(path.join(root, "setup.cfg")),
    await exists(path.join(root, "requirements.txt")),
    await exists(path.join(root, "pytest.ini")),
  ];
  if (!markers.some(Boolean)) return false;
  const python = process.platform === "win32" ? "python" : "python3";
  const has = (needle: string): boolean => pyproject?.includes(needle) ?? false;

  if (has("[tool.mypy") || (await exists(path.join(root, "mypy.ini")))) {
    out.add({
      role: "typecheck",
      label: "mypy",
      command: { command: python, args: ["-m", "mypy", "."] },
      source: "mypy configuration",
      selected: true,
    });
  }
  if (has("[tool.ruff") || (await exists(path.join(root, "ruff.toml")))) {
    out.add({
      role: "lint",
      label: "ruff check",
      command: { command: python, args: ["-m", "ruff", "check", "."] },
      source: "ruff configuration",
      selected: true,
    });
  }
  if (
    has("[tool.pytest") ||
    (await exists(path.join(root, "pytest.ini"))) ||
    (await exists(path.join(root, "tests"))) ||
    (await exists(path.join(root, "test")))
  ) {
    out.add({
      role: "test",
      label: "pytest",
      command: { command: python, args: ["-m", "pytest"] },
      source: "pytest configuration or tests directory",
      selected: true,
    });
  }
  return true;
}

async function detectRust(root: string, out: Collector): Promise<boolean> {
  if (!(await exists(path.join(root, "Cargo.toml")))) return false;
  out.add({
    role: "typecheck",
    label: "cargo check",
    command: { command: "cargo", args: ["check"] },
    source: "Cargo.toml",
    selected: true,
  });
  out.add({
    role: "lint",
    label: "cargo clippy",
    command: { command: "cargo", args: ["clippy", "--", "-D", "warnings"] },
    source: "Cargo.toml",
    selected: false,
  });
  out.add({
    role: "test",
    label: "cargo test",
    command: { command: "cargo", args: ["test"] },
    source: "Cargo.toml",
    selected: true,
  });
  return true;
}

async function detectGo(root: string, out: Collector): Promise<boolean> {
  if (!(await exists(path.join(root, "go.mod")))) return false;
  out.add({
    role: "lint",
    label: "go vet",
    command: { command: "go", args: ["vet", "./..."] },
    source: "go.mod",
    selected: true,
  });
  out.add({
    role: "test",
    label: "go test",
    command: { command: "go", args: ["test", "./..."] },
    source: "go.mod",
    selected: true,
  });
  out.add({
    role: "build",
    label: "go build",
    command: { command: "go", args: ["build", "./..."] },
    source: "go.mod",
    selected: false,
  });
  return true;
}

async function detectMake(root: string, out: Collector): Promise<boolean> {
  const text =
    (await readText(path.join(root, "Makefile"))) ?? (await readText(path.join(root, "makefile")));
  if (text === undefined) return false;
  const targets: Array<[CheckRole, string[]]> = [
    ["typecheck", ["typecheck"]],
    ["lint", ["lint"]],
    ["test", ["test", "check"]],
  ];
  let found = false;
  for (const [role, names] of targets) {
    if (out.has(role)) continue;
    const target = names.find((name) => new RegExp(`^${name}\\s*:`, "m").test(text));
    if (!target) continue;
    found = true;
    out.add({
      role,
      label: `make ${target}`,
      command: { command: "make", args: [target] },
      source: `Makefile ${target}`,
      selected: true,
    });
  }
  return found;
}

/**
 * Inspect a repository root and propose deterministic quality gates. Commands
 * are always command + argv pairs; nothing here is ever run through a shell.
 */
export async function detectRepository(directory: string): Promise<RepoDetection> {
  const gitRoot = await resolveGitRoot(directory);
  const root = gitRoot ?? path.resolve(directory);
  const collector = createCollector();
  const ecosystems: string[] = [];

  const packageManager = await detectNode(root, collector);
  if (packageManager) ecosystems.push("node");
  if (await detectPython(root, collector)) ecosystems.push("python");
  if (await detectRust(root, collector)) ecosystems.push("rust");
  if (await detectGo(root, collector)) ecosystems.push("go");
  if (await detectMake(root, collector)) ecosystems.push("make");

  const commands = [...collector.list].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role),
  );
  const defaultBranch = gitRoot ? await detectDefaultBranch(root) : undefined;
  return {
    root,
    name: path.basename(root),
    isGitRepo: gitRoot !== undefined,
    ...(defaultBranch ? { defaultBranch } : {}),
    ecosystems,
    ...(packageManager ? { packageManager } : {}),
    commands,
  };
}

export function selectedCommands(detection: RepoDetection): CommandSpec[] {
  return detection.commands.filter((entry) => entry.selected).map((entry) => entry.command);
}
