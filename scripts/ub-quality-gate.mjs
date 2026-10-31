#!/usr/bin/env node
/**
 * Deterministic quality gate backed by the ub-mode tool chain
 * (crapper / dryer / mutator — https://github.com/unclebob/ub-mode).
 *
 * Why a wrapper instead of a bare command: `quality.commands` is spawned
 * without a shell (see AGENTS.md — no shell invocation), so a gate that needs
 * `$UB` or `~` expansion has to be a program. This one resolves the tool chain,
 * runs one gate, and passes the tool's exit code through unchanged, which is
 * exactly what the orchestrator records in `finalQuality` and what the
 * evolution scorer reads.
 *
 * Exit codes (crapper's own contract):
 *   0  clean
 *   2  worst score above the threshold — treated as a failing gate
 *   1  tool, argument or project error
 *   3  this wrapper could not find the ub-mode tool chain
 *
 * Usage:
 *   node scripts/ub-quality-gate.mjs [--tool crapper|dryer|mutator]
 *                                    [--threshold 10] [--all] [--ub PATH]
 *                                    [-- <extra tool args>]
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = `usage: node scripts/ub-quality-gate.mjs [--tool crapper|dryer|mutator] [--threshold N]
                                  [--rust-threshold N] [--baseline PATH] [--update-baseline]
                                  [--all] [--ub PATH] [-- extra args]`;
const TOOLS = ["crapper", "dryer", "mutator"];

/**
 * `src-tauri` is scored for complexity only: its Tauri commands need a live
 * AppHandle, so unit tests cannot reach them and coverage is structurally 0%.
 * CRAP = CC² + CC at 0% coverage would demand CC ≤ 3 for every glue function,
 * which is not a useful target. The Rust layer therefore gets its own,
 * complexity-only threshold.
 */
export const RUST_ROOT = "src-tauri";

/** Source trees scored with real CRAP (coverage from vitest). */
export const SOURCE_ROOTS = ["src", "web", "scripts"];

export function defaultOptions(env = process.env) {
  return {
    tool: "crapper",
    threshold: "10",
    rustThreshold: "20",
    changed: true,
    baseline: DEFAULT_BASELINE,
    updateBaseline: false,
    ub: env.UB_BIN?.trim() || "",
    extra: [],
  };
}

export const DEFAULT_BASELINE = ".ub-crap-baseline.json";

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

/** Flags that consume the next argument, mapped to the option they set. */
const VALUE_FLAGS = {
  "--tool": "tool",
  "--threshold": "threshold",
  "--rust-threshold": "rustThreshold",
  "--ub": "ub",
  "--baseline": "baseline",
};

/** Flags that only flip a boolean. */
const BOOLEAN_FLAGS = {
  "--all": ["changed", false],
  "--update-baseline": ["updateBaseline", true],
};

export function parseArgs(argv, env = process.env) {
  const options = defaultOptions(env);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      options.extra = argv.slice(index + 1);
      break;
    }
    if (arg === "--help" || arg === "-h") return { ...options, help: true };
    const flag = BOOLEAN_FLAGS[arg];
    if (flag) {
      options[flag[0]] = flag[1];
      continue;
    }
    const key = VALUE_FLAGS[arg];
    if (key) {
      options[key] = takeValue(argv, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument '${arg}'\n${USAGE}`);
  }
  if (!TOOLS.includes(options.tool)) {
    throw new Error(`--tool must be crapper, dryer or mutator (got '${options.tool}')`);
  }
  return options;
}

export function resolveUb(explicit, env = process.env) {
  if (explicit) return installedOrUndefined(explicit);
  const candidates = [".kimi-code", ".agents"].map((home) =>
    path.join(os.homedir(), home, "tools", "ub", "ub"),
  );
  return candidates.map(installedOrUndefined).find(Boolean) ?? (env.UB_BIN?.trim() || undefined);
}

function installedOrUndefined(candidate) {
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Paths to analyze for one layer. crapper honors `--changed` over any filter,
 * so a layered run has to name its files: the changed set is partitioned here.
 */
export function layerTargets(options, layer, changedFiles) {
  if (!options.changed) {
    return layer === "rust" ? [RUST_ROOT] : [...SOURCE_ROOTS];
  }
  const wanted = changedFiles.filter((file) =>
    layer === "rust" ? file.startsWith(`${RUST_ROOT}/`) : !file.startsWith(`${RUST_ROOT}/`),
  );
  return wanted;
}

export function toolArgs(options, layer = "typescript", changedFiles = []) {
  const targets = layerTargets(options, layer, changedFiles);
  if (options.tool !== "crapper") {
    return [options.tool, "--threshold", options.threshold, ...options.extra];
  }
  if (targets.length === 0) return undefined;
  const args = [options.tool, ...targets];
  if (layer === "rust") {
    // Complexity only: see RUST_ROOT above.
    args.push("--no-coverage", "--threshold", options.rustThreshold);
  } else {
    args.push("--threshold", options.threshold);
  }
  return [...args, ...options.extra];
}

/** Source files reported by git, relative to the repository root. */
export function changedSources(cwd = process.cwd()) {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return undefined;
  const files = result.stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((entry) => entry.split(" -> ").pop() ?? entry);
  return files.filter((file) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|rs)$/.test(file));
}

/** Worst CRAP per function, read from the EDN crapper writes. */
export function readScores(metricsPath) {
  if (!existsSync(metricsPath)) return new Map();
  const text = readFileSync(metricsPath, "utf8");
  const scores = new Map();
  for (const match of text.matchAll(
    /\{:name "([^"]*)", :namespace "([^"]*)", :complexity (\d+), :coverage ([\d.]+), :crap ([\d.]+)\}/g,
  )) {
    scores.set(`${match[2]}#${match[1]}`, Number(match[5]));
  }
  return scores;
}

export function readBaseline(baselinePath) {
  if (!existsSync(baselinePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
    return parsed && typeof parsed.scores === "object" ? parsed.scores : undefined;
  } catch {
    return undefined;
  }
}

/** Functions that got worse than the frozen baseline. */
export function regressions(scores, baseline, threshold = 10) {
  const worse = [];
  for (const [key, score] of scores) {
    if (score <= threshold) continue;
    const frozen = baseline[key];
    if (frozen === undefined || score > frozen) worse.push({ key, score, frozen });
  }
  return worse;
}

export function main(argv = process.argv.slice(2)) {
  const prepared = prepare(argv);
  if (prepared.status !== undefined) return prepared.status;
  // crapper in changed mode has nothing to score when nothing changed; the
  // other tools do not look at git at all.
  if (isIdleCrapperRun(prepared.options)) return baselineStep(prepared.options);
  const failed = runLayers(prepared.ub, prepared.options);
  // Seeding a baseline records reality even when the layers are still red.
  if (prepared.options.updateBaseline) return baselineStep(prepared.options);
  return failed === 0 ? baselineStep(prepared.options) : failed;
}

function runLayers(ub, options) {
  const files = layersInput(options);
  return layers(options).reduce((worst, layer) => {
    const args = toolArgs(options, layer, files);
    return args ? Math.max(worst, runLayer(ub, args, layer)) : worst;
  }, 0);
}

function isIdleCrapperRun(options) {
  return options.tool === "crapper" && options.changed && layersInput(options).length === 0;
}

/** The changed files, or an empty list when nothing changed. */
function layersInput(options) {
  if (!options.changed) return [];
  return changedSources() ?? [];
}

/** Parse the arguments and find the tool chain, or report why we stop. */
function prepare(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return { status: 1 };
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return { status: 0 };
  }
  const ub = resolveUb(options.ub);
  if (!ub) {
    process.stderr.write(
      "ub-mode tool chain not found. Install it (https://github.com/unclebob/ub-mode) " +
        "and pass --ub PATH or set UB_BIN.\n",
    );
    return { status: 3 };
  }
  return { ub, options };
}

function runLayer(ub, args, layer) {
  process.stdout.write(`gate: ${layer} layer -> ${args[1]}\n`);
  const result = spawnSync(ub, args, { stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`failed to run ${ub}: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

/**
 * The Rust layer runs first so the metrics file left behind is the one with
 * real CRAP scores: `--no-coverage` reports N/A and carries no `:crap`.
 */
export function layers(options) {
  return options.tool === "crapper" ? ["rust", "typescript"] : ["typescript"];
}

/**
 * Freeze what is already over the threshold so a new or worsened function
 * fails the gate even when nobody touches the file that owns it.
 */
export function baselineStep(options, cwd = process.cwd()) {
  if (options.tool !== "crapper") return 0;
  const scores = readScores(path.join(cwd, ".metrics", "crap.edn"));
  const baselinePath = path.resolve(cwd, options.baseline);
  if (options.updateBaseline) return writeBaseline(scores, baselinePath, options.baseline);
  const baseline = readBaseline(baselinePath);
  if (!baseline) return 0;
  return reportRegressions(regressions(scores, baseline));
}

function writeBaseline(scores, baselinePath, label) {
  const frozen = Object.fromEntries([...scores].filter(([, score]) => score > 10));
  const payload = { updatedAt: new Date().toISOString(), scores: frozen };
  writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`baseline: wrote ${Object.keys(frozen).length} functions to ${label}\n`);
  return 0;
}

function reportRegressions(worse) {
  if (worse.length === 0) return 0;
  process.stderr.write(`baseline: ${worse.length} function(s) worse than the frozen baseline\n`);
  for (const entry of worse.slice(0, 20)) {
    process.stderr.write(`  ${entry.key}: ${entry.score.toFixed(1)} (frozen ${entry.frozen})\n`);
  }
  return 2;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  process.exit(main());
}
