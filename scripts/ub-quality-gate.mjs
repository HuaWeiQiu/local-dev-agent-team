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
 *                                    [--drift-report PATH]
 *                                    [-- <extra tool args>]
 *
 * `--drift-report PATH` is the nightly mode: score the whole project, compare the
 * result with the frozen baseline, write `{new, worse, fixed}` as JSON and exit 0.
 * A tool crash is not a ledger verdict: it writes `kind: "infrastructure"` and
 * exits non-zero, so a broken run can never be mistaken for a clean ledger.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mergeCoverageReports } from "./coverage-merge.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os, { arch, platform } from "node:os";
import path from "node:path";

const USAGE = `usage: node scripts/ub-quality-gate.mjs [--tool crapper|dryer|mutator] [--threshold N]
                                  [--rust-threshold N] [--baseline PATH] [--update-baseline]
                                  [--all] [--ub PATH] [--drift-report PATH]
                                  [--coverage-a PATH --coverage-b PATH] [--expect-base REF]
                                  [-- extra args]

  --update-cc-baseline       rebuild the complexity census (.ub-cc-baseline.json) from a full
                             scan. Same precondition as --update-baseline: HEAD must be the
                             commit that becomes main, or pass --expect-base REF.

  --update-baseline          only on the tree that will become main. The gate compares
                             HEAD with origin/main (or with --expect-base REF) and refuses
                             to write otherwise: a baseline freezes whatever it measures,
                             so measuring a stale tree freezes debt that was already paid.
                             When origin/main cannot be resolved (offline, detached) the
                             refresh is refused unless --expect-base names the commit.

  --coverage-a/--coverage-b  two independently produced coverage reports. They must cover
                             the same lines for a baseline to be written (hit counts may
                             differ); when they do not, both reports are kept under
                             target/coverage/unstable/ for offline comparison.
                             Add --coverage-c for a third run: the three are then merged
                             line by line by majority (a line covered in >= 2 of 3 counts
                             as covered), which is the caliber a refresh should use —
                             one missed line does not invalidate a whole report.
                             These two REQUIRE --use-existing-coverage (after the "--"),
                             otherwise the gate regenerates its own coverage and ignores
                             the pair:

                               node scripts/ub-quality-gate.mjs --all --update-baseline \
                                 --coverage-a A --coverage-b B -- --use-existing-coverage`;
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
    driftReport: "",
    coverageA: "",
    coverageB: "",
    coverageC: "",
    expectBase: "",
    ccBaseline: DEFAULT_CC_BASELINE,
    updateCcBaseline: false,
    ub: env.UB_BIN?.trim() || "",
    extra: [],
  };
}

export const DEFAULT_BASELINE = ".ub-crap-baseline.json";

/**
 * Every function this gate has ever measured, with its complexity. A full snapshot, not only the
 * entries over a threshold: the CRAP baseline holds eight-thousandths of nothing useful here —
 * `validateAuditOwnership` scores 9.0 and is therefore absent from it, which would make it look
 * new on the first run of this gate.
 */
export const DEFAULT_CC_BASELINE = ".ub-cc-baseline.json";

/**
 * The complexity a function this gate has never seen may have.
 *
 * No coverage clause on purpose. Coverage does not buy margin once cc is this high: cc 10 at
 * 100% coverage is CRAP 10.0 and cc 9 at 100% is 9.0 — both measured in this repository, both
 * exactly on the line with nothing left over. cc 4 at 40% coverage is 7.5.
 */
export const NEW_FUNCTION_CC_LIMIT = 4;

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
  "--drift-report": "driftReport",
  "--coverage-a": "coverageA",
  "--coverage-b": "coverageB",
  "--coverage-c": "coverageC",
  "--expect-base": "expectBase",
  "--cc-baseline": "ccBaseline",
};

/** Flags that only flip a boolean. */
const BOOLEAN_FLAGS = {
  "--all": ["changed", false],
  "--update-baseline": ["updateBaseline", true],
  "--update-cc-baseline": ["updateCcBaseline", true],
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
  return validated(options);
}

/**
 * The refusals that only make sense once every argument has been read.
 *
 * Apart from the loop because they are a different question: the loop asks "what did
 * this token say", these ask "does the set of answers make sense together". At ten
 * branches `parseArgs` sat on CRAP 10.0 exactly — cc 10 at 100% coverage, no margin
 * left for a single uncovered line — and two of those branches were never about
 * parsing.
 */
function validated(options) {
  if (!TOOLS.includes(options.tool)) {
    throw new Error(`--tool must be crapper, dryer or mutator (got '${options.tool}')`);
  }
  if (options.updateBaseline && options.updateCcBaseline) {
    throw new Error(
      "--update-baseline and --update-cc-baseline are two different files: run them one at a " +
        "time, ledger first so the census is measured on the same tree",
    );
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
  return files.filter(isScoredSource);
}

/** crapper skips test paths when it walks the tree; a changed list must match. */
export function isScoredSource(file) {
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|rs)$/.test(file) === false) return false;
  return !(file.startsWith("test/") || file.includes("/e2e/") || /\.(test|spec)\.[a-z]+$/.test(file));
}

/**
 * Every function the tool measured, by key, with both numbers this gate needs.
 *
 * `file::function` would read better than `namespace#function`, but the report carries no file:
 * it has `:name` and `:namespace`, and the namespace is the module path in dotted form. Deriving
 * a path from it means guessing, and one wrong guess makes every function in that file look new —
 * the single false positive this gate cannot afford. So the key is the one the tool emits and the
 * CRAP baseline already uses.
 */
export function readFunctions(metricsPath) {
  if (!existsSync(metricsPath)) return new Map();
  const text = readFileSync(metricsPath, "utf8");
  const functions = new Map();
  for (const match of text.matchAll(
    /\{:name "([^"]*)", :namespace "([^"]*)", :complexity (\d+), :coverage ([\d.]+), :crap ([\d.]+)\}/g,
  )) {
    functions.set(`${match[2]}#${match[1]}`, {
      complexity: Number(match[3]),
      coverage: Number(match[4]),
      crap: Number(match[5]),
    });
  }
  return functions;
}

/** Worst CRAP per function, read from the EDN crapper writes. */
export function readScores(metricsPath) {
  const scores = new Map();
  for (const [key, value] of readFunctions(metricsPath)) scores.set(key, value.crap);
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

/**
 * A metrics file left by an earlier run describes code that has since changed.
 * Reading it would compare the present against a measurement of the past — the
 * gate once failed on a function that no longer existed for exactly this reason.
 * Deleting it first means the baseline step can only ever read what this run
 * measured; when nothing was measured, it reads nothing and reports nothing.
 */
export function clearMetrics(cwd = process.cwd()) {
  const metrics = path.join(cwd, ".metrics", "crap.edn");
  if (!existsSync(metrics)) return false;
  rmSync(metrics, { force: true });
  return true;
}

/**
 * Directories a freshness walk never enters. They hold copies of source (build output, an
 * installed dependency tree) and would make every report look stale the moment anything was
 * installed or built.
 */
const FRESHNESS_SKIP = new Set(["node_modules", "dist", "target", ".git", "coverage", ".metrics"]);

/** Extensions the scored layers actually read. */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"]);

/** The entries of a directory, or none when it cannot be read. */
function entriesIn(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Every file under a directory that the scored layers could read, skipping build output. */
function sourceFilesIn(directory) {
  const found = [];
  for (const entry of entriesIn(directory)) {
    if (FRESHNESS_SKIP.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFilesIn(full));
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) found.push(full);
  }
  return found;
}

/** The newest of these files by mtime, or undefined when none of them could be read. */
function newestByMtime(files) {
  const timed = files
    .map((file) => ({ path: file, stats: statSync(file, { throwIfNoEntry: false }) }))
    .filter((entry) => entry.stats !== undefined)
    .map((entry) => ({ path: entry.path, mtimeMs: entry.stats.mtimeMs }));
  if (timed.length === 0) return undefined;
  return timed.reduce((latest, entry) => (entry.mtimeMs > latest.mtimeMs ? entry : latest));
}

/** The newest source file under the scored roots, or undefined when there is none. */
export function newestSource(cwd = process.cwd(), roots = SOURCE_ROOTS) {
  return newestByMtime(roots.flatMap((root) => sourceFilesIn(path.join(cwd, root))));
}

/**
 * Which coverage reports this run will actually be scored against.
 *
 * A refresh replaces the canonical report with its declared inputs, so the inputs are the
 * ones that have to be fresh. Every other run scores whatever sits at the canonical path.
 */
export function scoredCoverageReports(options, cwd = process.cwd()) {
  if (!usesExistingCoverage(options)) return [];
  if (options.updateBaseline) {
    return [options.coverageA, options.coverageB, options.coverageC]
      .filter(Boolean)
      .map((file) => path.resolve(cwd, file));
  }
  return [coveragePath(cwd)];
}

/**
 * A coverage report is an input, and an input older than the sources cannot describe them.
 *
 * Not hypothetical: pointing vitest at another `reportsDirectory` leaves the report crapper
 * actually reads at its old path, and the tool then scores today's functions against
 * yesterday's line numbers. A correct function measured 210.0 that way — a number that sends
 * someone to rewrite code that is fine. Nothing in the run says so, which is why this is a
 * gate and not a note: the failure has no other symptom.
 */
export function staleCoverageRefusal(options, cwd = process.cwd()) {
  const reports = scoredCoverageReports(options, cwd);
  if (reports.length === 0) return undefined;
  const source = newestSource(cwd);
  if (!source) return undefined;
  for (const report of reports) {
    const stats = statSync(report, { throwIfNoEntry: false });
    // A missing report is a different refusal, raised once the layers actually run.
    if (!stats) continue;
    if (stats.mtimeMs > source.mtimeMs) continue;
    process.stderr.write(
      "gate: refusing to score — coverage is stale; regenerate it.\n" +
        `  report  ${new Date(stats.mtimeMs).toISOString()}  ${path.relative(cwd, report)}\n` +
        `  source  ${new Date(source.mtimeMs).toISOString()}  ${path.relative(cwd, source.path)}\n\n` +
        "The report predates the code it would be scored against, so its line numbers may " +
        "belong to a different function: one that is correct came out as 210.0 that way.\n" +
        "Regenerate it where the gate looks for it:\n" +
        "  npx vitest run --coverage --coverage.reporter=lcov \\\n" +
        "    --coverage.reportsDirectory=target/coverage/typescript\n",
    );
    return 1;
  }
  return undefined;
}

/**
 * The whole run, against the tree at `cwd`.
 *
 * `cwd` is a parameter rather than a global it reads. A function that consults
 * `process.cwd()` half a dozen times can only be tested by moving the process —
 * `process.chdir` inside a test file changes state the next test inherits, and a
 * test that has to do that is reporting a shape problem, not a coverage gap. Every
 * callee below already took `cwd`; this was the one place still reaching for the
 * ambient value.
 */
export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const prepared = prepare(argv);
  if (prepared.status !== undefined) return prepared.status;
  const stale = staleCoverageRefusal(prepared.options, cwd);
  if (stale !== undefined) return refuseForStaleCoverage(prepared, stale, cwd);
  if (prepared.options.updateCcBaseline) {
    return writeCcSnapshot(prepared.ub, prepared.options, cwd);
  }
  if (prepared.options.driftReport) return driftStep(prepared.options, prepared.ub, cwd);
  clearMetrics(cwd);
  // crapper in changed mode has nothing to score when nothing changed; the
  // other tools do not look at git at all.
  if (isIdleCrapperRun(prepared.options)) return baselineStep(prepared.options, cwd);
  // Seeding a baseline records reality even when the layers are still red — but only
  // reality that repeats. See stableBaseline().
  if (prepared.options.updateBaseline) return stableBaseline(prepared.ub, prepared.options, cwd);
  const failed = runLayers(prepared.ub, prepared.options, cwd);
  return failed === 0 ? baselineStep(prepared.options, cwd) : failed;
}

/**
 * Staleness ends the run either way; how it is *recorded* depends on who is reading.
 *
 * The nightly contract is that a run which could not measure anything is an infrastructure
 * verdict, never an empty ledger — a missing file would read as "no drift", which is the one
 * answer that hides the problem.
 */
function refuseForStaleCoverage(prepared, status, cwd = process.cwd()) {
  if (!prepared.options.driftReport) return status;
  writeDriftReport(
    prepared.options.driftReport,
    driftPayload({
      error: "coverage is stale: the report predates the sources it would score",
      threshold: Number(prepared.options.threshold),
      baseline: prepared.options.baseline,
      provenance: provenance({ ub: prepared.ub, env: process.env }),
    }),
    cwd,
  );
  return status;
}

function runLayers(ub, options, cwd = process.cwd()) {
  const files = layersInput(options);
  return layers(options).reduce((worst, layer) => {
    const args = toolArgs(options, layer, files);
    return args ? Math.max(worst, runLayer(ub, args, layer, cwd)) : worst;
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
    if (options.driftReport) {
      writeDriftReport(
        options.driftReport,
        driftPayload({
          error: "ub-mode tool chain not found",
          threshold: Number(options.threshold),
          baseline: options.baseline,
          provenance: provenance({ env: process.env }),
        }),
      );
    }
    process.stderr.write(
      "ub-mode tool chain not found. Install it (https://github.com/unclebob/ub-mode) " +
        "and pass --ub PATH or set UB_BIN.\n",
    );
    return { status: 3 };
  }
  return { ub, options };
}

function runLayer(ub, args, layer, cwd = process.cwd()) {
  process.stdout.write(`gate: ${layer} layer -> ${args[1]}\n`);
  const result = spawnSync(ub, args, { stdio: "inherit", cwd });
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
 * What this measurement knows that the snapshot does not.
 *
 * Renames land here by design: a function that changes its name is a function nobody has
 * measured, and "give it a new name" must not be a way out of the allowance. The way out is to
 * delete the old key from the snapshot and say why in the commit — an edit a reviewer can see,
 * rather than a flag that quietly widens the gate.
 */
export function newcomers(functions, snapshot) {
  const unknown = new Map();
  for (const [key, value] of functions) {
    if (key in snapshot) continue;
    unknown.set(key, value.complexity);
  }
  return unknown;
}

/** The newcomers above the allowance, worst first. */
export function overComplexNewcomers(functions, snapshot, limit = NEW_FUNCTION_CC_LIMIT) {
  return [...newcomers(functions, snapshot)]
    .filter(([, complexity]) => complexity > limit)
    .sort((left, right) => right[1] - left[1]);
}

/** The complexity snapshot: a full census, so absence means "never measured", not "fine". */
export function readCcSnapshot(pathname) {
  if (!existsSync(pathname)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(pathname, "utf8"));
    return parsed && typeof parsed.counts === "object" ? parsed.counts : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Refuse a gate run whose new functions are too complex to trust.
 *
 * The snapshot is required rather than optional: without it every function is a newcomer, and a
 * gate that fails on everything is a gate somebody switches off. A missing snapshot is therefore
 * its own refusal with the command that fixes it.
 */
export function newcomerRefusal(options, functions, cwd = process.cwd()) {
  if (functions.size === 0) return undefined;
  const snapshot = readCcSnapshot(path.resolve(cwd, options.ccBaseline));
  if (!snapshot) {
    process.stderr.write(
      `gate: refusing to score — no complexity snapshot at ${options.ccBaseline}.\n\n` +
        "The snapshot is a census of every function already measured, so a missing one reads as " +
        "\"all of them are new\". Build it once, from the tree that will become main:\n" +
        "  node scripts/ub-quality-gate.mjs --all --update-cc-baseline\n",
    );
    return 1;
  }
  const over = overComplexNewcomers(functions, snapshot);
  if (over.length === 0) return undefined;
  process.stderr.write(
    `gate: refusing to score — ${over.length} new function(s) above the complexity allowance ` +
      `of ${NEW_FUNCTION_CC_LIMIT}:\n`,
  );
  for (const [key, complexity] of over) {
    process.stderr.write(`  cc ${String(complexity).padStart(3)}  ${key}\n`);
  }
  process.stderr.write(
    "\nA function this gate has never seen may not arrive above the allowance. Neither does a " +
      "refresh get around it: `--update-baseline` may close debt and may not open it, and " +
      "`--update-cc-baseline` only runs on the commit that becomes main.\n" +
      `Split it until every piece is at most ${NEW_FUNCTION_CC_LIMIT}.\n`,
  );
  return 1;
}

/**
 * Freeze what is already over the threshold so a new or worsened function
 * fails the gate even when nobody touches the file that owns it.
 */
export function baselineStep(options, cwd = process.cwd()) {
  if (options.tool !== "crapper") return 0;
  const metricsPath = path.join(cwd, ".metrics", "crap.edn");
  const newcomer = newcomerRefusal(options, readFunctions(metricsPath), cwd);
  if (newcomer !== undefined) return newcomer;
  const scores = readScores(metricsPath);
  const baselinePath = path.resolve(cwd, options.baseline);
  if (options.updateBaseline) return writeBaseline(scores, baselinePath, options.baseline);
  const baseline = readBaseline(baselinePath);
  if (!baseline) return 0;
  return reportRegressions(regressions(scores, baseline));
}

/**
 * Keys two scans disagree about. A baseline written from one scan of a run whose
 * scores wobble freezes a number nobody can reproduce — that is how `getInventory`
 * ended up frozen at 20.24 while measuring 23.90 at its own commit.
 */
/** Scores below this absolute move are rounding noise, whatever their ratio. */
const NOISE_FLOOR = 0.5;

/** Relative move that counts as jitter rather than debt. */
const NOISE_TOLERANCE = 0.05;

export function unstableKeys(first, second, tolerance = 0.05, threshold = 10) {
  const keys = new Set([...first.keys(), ...second.keys()]);
  const drift = [];
  for (const key of keys) {
    const entry = unstableEntry(key, first.get(key), second.get(key), tolerance, threshold);
    if (entry) drift.push(entry);
  }
  return drift.sort((left, right) => left.key.localeCompare(right.key));
}

/** Why one key counts as unstable, or nothing when it does not. */
function unstableEntry(key, before, after, tolerance, threshold) {
  if (!reachesLedger(before, after, threshold)) return undefined;
  if (before === undefined || after === undefined) return missingSide(key, before, after);
  if (crossedLine(before, after, threshold)) return { key, first: before, second: after };
  return jitter(key, before, after, tolerance);
}

/** A function the baseline could freeze: at least one scan is over the line. */
function reachesLedger(before, after, threshold) {
  return Math.max(before ?? 0, after ?? 0) > threshold;
}

function missingSide(key, before, after) {
  return before === after ? undefined : { key, first: before, second: after };
}

/** One scan freezes it, the other does not — unstable however small the move. */
function crossedLine(before, after, threshold) {
  return before > threshold !== after > threshold;
}

/** Both scans are over the line: the judgement is about how far the number moved. */
function jitter(key, before, after, tolerance) {
  const deviation = Math.abs(after - before) / Math.max(before, after, 1);
  const absolute = Math.abs(after - before);
  // Relative-only would flag a 1.00 -> 1.13 wobble (noise on a trivial function).
  // Absolute-only would miss a 100 -> 106 drift on an expensive one. Both bars.
  if (deviation <= tolerance || absolute <= NOISE_FLOOR) return undefined;
  return { key, first: before, second: after, deviation };
}

/**
 * One full scan in a clean state. Both leftovers matter: a stale metrics file would
 * be scored, and a stale coverage report would be *merged into* the new run — that is
 * how two scans of one commit disagreed (JevPanel#Row 6.0 -> 2.09), and how a
 * baseline once froze a number its own commit could not reproduce.
 */
export function usesExistingCoverage(options) {
  return (options.extra ?? []).includes("--use-existing-coverage");
}

function coveragePath(cwd) {
  return path.join(cwd, "target", "coverage", "typescript", "lcov.info");
}

/**
 * One full scan. In self mode the coverage report is regenerated each time, so the two
 * scans really do test whether coverage is stable. In existing mode the report is an
 * input: it is hashed before each scan and must not change between them — a report
 * edited mid-measurement is worse than a wobbling one, because it looks authoritative.
 */
function scanOnce(ub, options, cwd) {
  const existing = usesExistingCoverage(options);
  clearMetrics(cwd);
  if (!existing) rmSync(path.join(cwd, "target", "coverage"), { recursive: true, force: true });
  const before = lcovProvenance(coveragePath(cwd));
  runLayers(ub, { ...options, changed: false }, cwd);
  const functions = readFunctions(path.join(cwd, ".metrics", "crap.edn"));
  return {
    scores: readScores(path.join(cwd, ".metrics", "crap.edn")),
    functions,
    lcov: lcovProvenance(coveragePath(cwd)),
    before,
    existing,
  };
}

/**
 * Seed the baseline only from numbers that repeat. The rule used to be a note in a
 * document ("two `--all` runs must agree key by key"); a note gets forgotten, so the
 * gate now refuses to write when the two scans disagree.
 */
/**
 * A refresh must rest on a coverage report two independent runs agree on. Hashing one
 * report proves it was not edited; it does not prove it is not a lucky sample — that is
 * exactly how a 20.24 got frozen for a function that measured 23.90 everywhere else.
 */
/**
 * What CRAP actually consumes: which lines were executed, not how many times. Two runs
 * of the same suite hit the same lines but with different counters, so raw file bytes
 * differ on every run while the measurement is identical. Comparing bytes would refuse
 * every refresh forever; comparing this signature refuses only real differences.
 */
export function coverageSignature(text) {
  const covered = new Map();
  let current;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      current = line.slice(3);
      covered.set(current, new Set());
      continue;
    }
    if (current && line.startsWith("DA:")) {
      const [number, hits] = line.slice(3).split(",");
      if (Number(hits) > 0) covered.get(current).add(Number(number));
    }
  }
  const digest = createHash("sha256");
  for (const file of [...covered.keys()].sort()) {
    digest.update(`${file}\n`);
    digest.update(`${[...covered.get(file)].sort((left, right) => left - right).join(",")}\n`);
  }
  return digest.digest("hex");
}

export function requireReproducibleCoverage(options, cwd = process.cwd()) {
  if (options.coverageC) return mergeThreeReports(options, cwd);
  const declared = [options.coverageA, options.coverageB];
  if (declared.some((file) => !file)) {
    process.stderr.write(
      "baseline: refusing to write — two coverage reports are required for a refresh " +
        "(--coverage-a PATH --coverage-b PATH), produced by two separate test runs\n",
    );
    return { status: 3 };
  }
  const paths = declared.map((file) => path.resolve(cwd, file));
  const [a, b] = paths.map((file) => lcovProvenance(file));
  if (!a || !b) {
    process.stderr.write(
      "baseline: refusing to write — two coverage reports are required for a refresh " +
        "(--coverage-a PATH --coverage-b PATH), produced by two separate test runs\n",
    );
    return { status: 3 };
  }
  const signatureA = coverageSignature(readFileSync(paths[0], "utf8"));
  const signatureB = coverageSignature(readFileSync(paths[1], "utf8"));
  if (signatureA !== signatureB) {
    return { status: preserveUnstableCoverage(paths, cwd, a, b, { signatureA, signatureB }) };
  }
  // The pair agrees: score the first one, from the canonical path crapper reads.
  mkdirSync(path.dirname(coveragePath(cwd)), { recursive: true });
  writeFileSync(coveragePath(cwd), readFileSync(paths[0]));
  return { status: undefined };
}

/** Keep both samples so the intermittent can be diagnosed offline, not re-caught live. */
function preserveUnstableCoverage(paths, cwd, a, b, signatures = {}) {
  const root = path.join(cwd, "target", "coverage", "unstable");
  mkdirSync(path.join(root, "a"), { recursive: true });
  mkdirSync(path.join(root, "b"), { recursive: true });
  const kept = [
    path.join(root, "a", "lcov.info"),
    path.join(root, "b", "lcov.info"),
  ];
  writeFileSync(kept[0], readFileSync(paths[0]));
  writeFileSync(kept[1], readFileSync(paths[1]));
  process.stderr.write(
    "baseline: refusing to write — the two coverage runs covered different lines " +
      `(${signatures.signatureA?.slice(0, 12)}… vs ${signatures.signatureB?.slice(0, 12)}…; ` +
      `raw ${a.sha256.slice(0, 12)}… vs ${b.sha256.slice(0, 12)}…); kept both samples:\n` +
      `  ${path.relative(cwd, kept[0])}\n  ${path.relative(cwd, kept[1])}\n`,
  );
  return 2;
}

export function stableBaseline(ub, options, cwd = process.cwd(), hooks = {}) {
  let mergeFacts;
  // Cheapest check first, and the one that has cost the most: a refresh measured on a
  // tree that is not the one about to become main freezes debt that is already paid.
  const wrongTree = baseRefusal(options, cwd);
  if (wrongTree !== undefined) return wrongTree;
  const misuse = coveragePairMisuse(options);
  if (misuse !== undefined) return misuse;
  const pairVerdict = coveragePairVerdict(options, cwd);
  if (pairVerdict?.status !== undefined) return pairVerdict.status;
  mergeFacts = pairVerdict?.merge;
  const first = scanOnce(ub, options, cwd);
  // Tests only: a tamper between the scans has no other seam, because in production
  // nothing in this process can be told to act there.
  hooks.betweenScans?.();
  const second = scanOnce(ub, options, cwd);
  const refusal = scanRefusal(first, second, cwd);
  if (refusal !== undefined) return refusal;
  // A refresh closes debt and does not open it. Without this, one `--update-baseline` would turn
  // a freshly split cc 9 block into an "existing" function and the allowance would never see it.
  const newcomer = newcomerRefusal(options, second.functions, cwd);
  if (newcomer !== undefined) return newcomer;
  return writeBaseline(
    second.scores,
    path.resolve(cwd, options.baseline),
    options.baseline,
    baselineGeneration({ ub, cwd, first, second, merge: mergeFacts }),
  );
}

/** What this tree is, and what it is supposed to become. */
export function baselineBase(options, cwd = process.cwd()) {
  const declared = options.expectBase?.trim();
  const target = declared || "origin/main";
  const resolved = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${target}^{commit}`], {
    cwd,
    encoding: "utf8",
  });
  const base = resolved.status === 0 ? resolved.stdout.trim() : undefined;
  return { head: gitHeadSha(cwd), target, base };
}

/**
 * A baseline is a promise about the tree that becomes `main`. Measured anywhere else it
 * makes a different promise: `#198` was measured before `#197` and froze 7 entries that had
 * already been cleared; `#206` did the same with 3 more. Nothing about that is carelessness
 * that more care would fix — the process simply had no gate, and a rule people have to
 * remember is a rule people forget. So this is not a flag: it runs on every refresh.
 *
 * Refusing to guess is part of it. When `origin/main` cannot be resolved (offline, detached
 * head, not a repository), a silent pass would be the same failure in a new costume, so the
 * refresh stops and asks for `--expect-base <ref|sha>`.
 */
export function baseRefusal(options, cwd = process.cwd()) {
  const { head, target, base } = baselineBase(options, cwd);
  if (!head) return refuseUnknownBase({ head, target, base, why: "HEAD is not readable here" });
  if (!base) return refuseUnknownBase({ head, target, base, why: `${target} does not resolve` });
  if (head === base) return undefined;
  process.stderr.write(
    "baseline: refusing to write — this tree is not the commit that will become main:\n" +
      `  HEAD         ${head}\n  ${target.padEnd(11)}  ${base}\n\n` +
      "A refresh freezes whatever it measures, and a stale tree measures debt that is " +
      "already paid: #198 froze 7 such entries, #206 froze 3.\n" +
      "Measure the tree that will become main:\n" +
      "  git fetch origin && git rebase origin/main   # then refresh\n" +
      "If this tree is the base under another name, say which: --expect-base <ref|sha>.\n",
  );
  return 1;
}

function refuseUnknownBase({ head, target, base, why }) {
  process.stderr.write(
    `baseline: refusing to write — cannot tell whether this tree will become main: ${why}.\n` +
      `  HEAD         ${head ?? "unreadable"}\n  ${target.padEnd(11)}  ${base ?? "unreadable"}\n\n` +
      "A baseline measured on the wrong tree freezes debt that is already paid, so this is " +
      "not guessed: fetch origin/main, or declare the commit explicitly with " +
      "--expect-base <ref|sha>.\n",
  );
  return 1;
}

/**
 * A pair without the flag would silently be ignored: the gate would regenerate its own
 * coverage (self mode), compare those two, and call the result a reproducible refresh.
 * Defaults must not change meaning because one flag was left out.
 */
function coveragePairMisuse(options) {
  const declared = Boolean(options.coverageA || options.coverageB);
  if (!declared || usesExistingCoverage(options)) return undefined;
  process.stderr.write(
    "baseline: refusing to write — --coverage-a/--coverage-b only apply together with " +
      "--use-existing-coverage; without it the gate regenerates its own coverage and " +
      "ignores the pair.\n\n" +
      "  node scripts/ub-quality-gate.mjs --all --update-baseline \\\n" +
      "    --coverage-a A --coverage-b B -- --use-existing-coverage\n",
  );
  return 1;
}

/** Existing mode only: the two input reports must agree before anything is scored. */
function coveragePairVerdict(options, cwd) {
  if (!usesExistingCoverage(options)) return undefined;
  return requireReproducibleCoverage(options, cwd);
}

/** Everything that makes two scans unusable as a baseline, or nothing. */
export function scanRefusal(first, second, cwd = process.cwd()) {
  const missing = missingCoverageRefusal(first, second, cwd);
  if (missing !== undefined) return missing;
  const tampered = tamperRefusal(first, second);
  if (tampered !== undefined) return tampered;
  const drift = unstableKeys(first.scores, second.scores);
  return drift.length > 0 ? refuseBaseline(drift) : undefined;
}

function missingCoverageRefusal(first, second, cwd) {
  const gone = [first, second].some((scan) => scan.existing && !scan.before);
  return gone ? refuseWithoutCoverage(coveragePath(cwd)) : undefined;
}

/** A report edited between the scans means the two scans measured different inputs. */
function tamperRefusal(first, second) {
  const changed = first.existing
    ? coverageChanged(first.lcov, second.before)
    : coverageChanged(first.before, second.before);
  return changed ? refuseTamperedCoverage(changed) : undefined;
}

/**
 * Three independent runs, merged line by line. A line is covered when at least two runs
 * executed it: one execution is sampling noise, zero is a path nobody tests. Report-level
 * voting is deliberately not used — it would let a block missed in one file decide the
 * verdict for every other file.
 */
function mergeThreeReports(options, cwd) {
  const paths = [options.coverageA, options.coverageB, options.coverageC].map((file) =>
    path.resolve(cwd, file),
  );
  const texts = paths.map((file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined));
  if (texts.some((text) => !text)) {
    process.stderr.write(
      "baseline: refusing to write — all three coverage reports are required for a merge " +
        "(--coverage-a --coverage-b --coverage-c)\n",
    );
    return { status: 3 };
  }
  const merged = mergeCoverageReports(texts);
  mkdirSync(path.dirname(coveragePath(cwd)), { recursive: true });
  writeFileSync(coveragePath(cwd), merged.lcov);
  process.stderr.write(
    `baseline: merged 3 coverage runs, ${merged.divergentLines} divergent line(s), ` +
      `${merged.partialFiles.length} partially-measured file(s)\n`,
  );
  return {
    status: undefined,
    merge: {
      runs: 3,
      rule: "line-majority",
      divergentLines: merged.divergentLines,
      partialFiles: merged.partialFiles.length,
      digests: paths.map((file) => lcovProvenance(file)?.sha256),
    },
  };
}

/** A missing report is not an empty ledger: it is no measurement at all. */
function refuseWithoutCoverage(file) {
  process.stderr.write(
    `baseline: refusing to write — no coverage report at ${path.relative(process.cwd(), file)}; ` +
      "run the test suite with --coverage --coverage.reporter=lcov first\n",
  );
  return 3;
}

/** The report is an input in existing mode; changing it mid-run invalidates both scans. */
function coverageChanged(first, second) {
  if (!first || !second) return undefined;
  return first.sha256 === second.sha256 ? undefined : { first, second };
}

function refuseTamperedCoverage({ first, second }) {
  process.stderr.write(
    "baseline: refusing to write — the coverage report changed between the two scans " +
      `(${first.sha256.slice(0, 12)}… -> ${second.sha256.slice(0, 12)}…)\n`,
  );
  return 2;
}

/** Say exactly which functions moved, then leave the file alone. */
function refuseBaseline(drift) {
  process.stderr.write(`baseline: refusing to write — two full scans disagree on ${drift.length} function(s)\n`);
  for (const entry of drift.slice(0, 10)) process.stderr.write(`  ${describeDrift(entry)}\n`);
  return 2;
}

export function describeDrift(entry) {
  const percent = entry.deviation ? ` (${(entry.deviation * 100).toFixed(1)}%)` : "";
  return `${entry.key}: ${entry.first ?? "absent"} -> ${entry.second ?? "absent"}${percent}`;
}

/** How this generation was produced, in the shape the baseline file records. */
/**
 * In existing mode the frozen numbers describe an input report, so that is the one
 * recorded; in self mode it is the report this scan produced.
 */
function frozenReport(existing, second) {
  return existing ? second.before : second.lcov;
}

/** The pair that proves the measurement: the same input twice, or two live runs. */
function agreedDigests(existing, first, second) {
  return existing
    ? [first.before?.sha256, second.before?.sha256]
    : [first.lcov?.sha256, second.lcov?.sha256];
}

export function baselineGeneration({ ub, cwd = process.cwd(), first, second, merge }) {
  const existing = Boolean(first.existing);
  const frozenLcov = frozenReport(existing, second);
  const agreed = agreedDigests(existing, first, second);
  return {
    headSha: gitHeadSha(cwd),
    toolCommit: ub ? toolCommit(ub) : undefined,
    ...machineProvenance(process.env),
    ...(existing ? { coverageSource: "existing" } : {}),
    scans: 2,
    generatedAt: new Date().toISOString(),
    // How the numbers were merged, and how much the runs disagreed: a rising
    // `divergentLines` is the earliest sign that the tests started wobbling again.
    ...(merge ? { merge } : {}),
    ...(frozenLcov ? { lcov: frozenLcov } : {}),
    ...(agreed[0] && agreed[1] ? { agreement: { scans: 2, sha256: agreed } } : {}),
  };
}

function writeBaseline(scores, baselinePath, label, generation) {
  const frozen = Object.fromEntries([...scores].filter(([, score]) => score > 10));
  // Who produced these numbers. Without it, "where did these 172 come from?" has the
  // same answer it had for the previous generation: some run, some time.
  const payload = {
    updatedAt: new Date().toISOString(),
    ...(generation ? { generation: dropUndefined(generation) } : {}),
    scores: frozen,
  };
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

/**
 * Compare a full scan with the frozen baseline. Three answers, because a nightly
 * reader acts on them differently: debt that appeared, debt that grew, debt that
 * was paid. `new` and `worse` are sorted by score, `fixed` by what it used to cost.
 */
/**
 * @param {Map<string, number>} scores
 * @param {Record<string, number>} baseline
 * @param {number} [threshold]
 * @returns {DriftReport}
 */
export function driftBetween(scores, baseline, threshold = 10) {
  return sortDrift({
    ...debtSince(scores, baseline, threshold),
    fixed: paidDebt(scores, baseline, threshold),
  });
}

/** Debt that appeared, and debt that grew; both already over the threshold. */
/**
 * @typedef {{ key: string, score: number }} NewDebt
 * @typedef {{ key: string, score: number, frozen: number }} WorseDebt
 * @typedef {{ key: string, frozen: number }} FixedDebt
 * @typedef {{
 *   new: NewDebt[],
 *   worse: WorseDebt[],
 *   fixed: FixedDebt[],
 *   withinNoise: WorseDebt[],
 * }} DriftReport
 */

/**
 * @param {Map<string, number>} scores
 * @param {Record<string, number>} baseline
 * @param {number} threshold
 * @returns {{ new: NewDebt[], worse: WorseDebt[], withinNoise: WorseDebt[] }}
 */
function debtSince(scores, baseline, threshold) {
  const fresh = [];
  const worse = [];
  const withinNoise = [];
  for (const [key, score] of scores) {
    if (score <= threshold) continue;
    const frozen = baseline[key];
    if (frozen === undefined) {
      fresh.push({ key, score });
      continue;
    }
    if (score <= frozen) continue;
    const entry = { key, score, frozen };
    // Crossing the ledger line is debt whatever the size: the baseline did not carry
    // this function, and now it does.
    if (frozen <= threshold) worse.push(entry);
    else if (withinNoiseBand(frozen, score)) withinNoise.push(entry);
    else worse.push(entry);
  }
  return { new: fresh, worse, withinNoise };
}

/**
 * A move inside the band is measurement jitter, not new debt. Reporting it would make
 * the nightly issue answer a 0.17 move, and an issue that answers noise trains people
 * to scroll past it — the signal-to-noise ratio matters more than the sensitivity.
 */
function withinNoiseBand(before, after) {
  const deviation = Math.abs(after - before) / Math.max(before, after, 1);
  return deviation <= NOISE_TOLERANCE || Math.abs(after - before) <= NOISE_FLOOR;
}

/** Baseline entries that no longer cost anything: gone, or back under the line. */
/**
 * @param {Map<string, number>} scores
 * @param {Record<string, number>} baseline
 * @param {number} threshold
 * @returns {FixedDebt[]}
 */
function paidDebt(scores, baseline, threshold) {
  const fixed = [];
  for (const [key, frozen] of Object.entries(baseline)) {
    const score = scores.get(key);
    if (score === undefined || score <= threshold) fixed.push({ key, frozen });
  }
  return fixed;
}

/** @param {DriftReport} report */
function sortDrift(report) {
  const byScore = (left, right) => right.score - left.score || left.key.localeCompare(right.key);
  report.new.sort(byScore);
  report.worse.sort(byScore);
  report.withinNoise.sort(byScore);
  report.fixed.sort((left, right) => right.frozen - left.frozen || left.key.localeCompare(right.key));
  return report;
}

/** The commit under test: a score without it cannot be reproduced. */
export function gitHeadSha(cwd = process.cwd()) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** The tool that produced the scores; a moving tool silently changes every number. */
export function toolCommit(ub, env = process.env) {
  const declared = env.UB_TOOL_COMMIT?.trim();
  return declared ? declared : commitOfToolCheckout(ub);
}

function commitOfToolCheckout(ub) {
  const toolDir = path.join(path.dirname(path.resolve(ub)), "crapper");
  const result = spawnSync("git", ["-C", toolDir, "rev-parse", "HEAD"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * The coverage report the scores were computed from, pinned by digest. Attribution
 * used to cost three rounds because nobody could say which lcov a number came from.
 */
export function lcovProvenance(file) {
  if (!existsSync(file)) return undefined;
  const bytes = readFileSync(file);
  return {
    path: path.relative(process.cwd(), file) || file,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** The machine that produced a verdict; nothing here depends on the repository. */
export function machineProvenance(env = process.env) {
  return {
    coverageSource: env.COVERAGE_SOURCE?.trim() || "self",
    platform: `${platform()}/${arch()}`,
    nodeVersion: process.version,
  };
}

/** What produced a verdict: code, tool, machine and the report behind the numbers. */
export function provenance({ ub, env = process.env, cwd = process.cwd(), lcovPath } = {}) {
  return {
    headSha: gitHeadSha(cwd),
    toolCommit: ub ? toolCommit(ub, env) : undefined,
    ...machineProvenance(env),
    lcov: lcovProvenance(lcovPath ?? path.join(cwd, "target", "coverage", "typescript", "lcov.info")),
  };
}

/**
 * @typedef {Object} DriftCounts
 * @property {number} new
 * @property {number} worse
 * @property {number} fixed
 */

/**
 * The payload has two shapes and `kind` discriminates them. An infrastructure
 * failure carries an `error`; a ledger result does not. Written as one flat
 * object with an optional `error`, a consumer could read it on the ledger branch
 * and get `undefined` from a field the type promised — which is how the nightly
 * issue once reported "unknown error" as if the scan had run.
 *
 * @typedef {Object} InfrastructureDrift
 * @property {"infrastructure"} kind
 * @property {string} generatedAt
 * @property {number} threshold
 * @property {string} baseline
 * @property {string} error
 * @property {DriftCounts} counts
 * @property {NewDebt[]} new
 * @property {WorseDebt[]} worse
 * @property {FixedDebt[]} fixed
 * @property {WorseDebt[]} withinNoise
 * @property {Record<string, unknown>} [provenance]
 */

/**
 * @typedef {Object} LedgerDrift
 * @property {"ledger"} kind
 * @property {string} generatedAt
 * @property {number} threshold
 * @property {string} baseline
 * @property {DriftCounts} counts
 * @property {NewDebt[]} new
 * @property {WorseDebt[]} worse
 * @property {FixedDebt[]} fixed
 * @property {WorseDebt[]} withinNoise
 * @property {Record<string, unknown>} [provenance]
 */

/**
 * The file the nightly workflow reads. `kind` is the whole point: an infrastructure
 * failure (missing tool chain, crashed scan, absent baseline) is not a ledger with
 * three zero counters, and must never be reported as "clean".
 *
 * @param {{
 *   report?: DriftReport,
 *   error?: string,
 *   threshold?: number,
 *   baseline?: string,
 *   provenance?: Record<string, unknown>,
 * }} options
 * @returns {InfrastructureDrift | LedgerDrift}
 */
export function driftPayload({
  report,
  error,
  threshold = 10,
  baseline = DEFAULT_BASELINE,
  provenance: origin,
}) {
  const empty = { new: [], worse: [], fixed: [], withinNoise: [] };
  const verdict = report ?? empty;
  return {
    kind: error ? "infrastructure" : "ledger",
    generatedAt: new Date().toISOString(),
    ...(origin ? { provenance: dropUndefined(origin) } : {}),
    threshold,
    baseline,
    ...(error ? { error } : {}),
    counts: {
      new: verdict.new.length,
      worse: verdict.worse.length,
      fixed: verdict.fixed.length,
    },
    new: verdict.new,
    worse: verdict.worse,
    fixed: verdict.fixed,
    // Kept as evidence, never counted: these moves are inside the noise band.
    withinNoise: verdict.withinNoise,
  };
}

export function writeDriftReport(pathname, payload, cwd = process.cwd()) {
  const target = path.resolve(cwd, pathname);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
  return target;
}

/**
 * Write the complexity census. Full scan, on the tree that will become main.
 *
 * Same precondition as the CRAP baseline and for the same reason: this file decides which
 * functions the allowance applies to, so writing it from a side branch would let a branch declare
 * its own newcomers "existing". Recording an entry is bookkeeping, not an exemption — the entry
 * only says the gate has seen it; the CRAP ledger still decides whether it is debt.
 */
export function writeCcSnapshot(ub, options, cwd = process.cwd()) {
  const wrongTree = baseRefusal(options, cwd);
  if (wrongTree !== undefined) return wrongTree;
  clearMetrics(cwd);
  const failed = runLayers(ub, { ...options, changed: false }, cwd);
  // Exit 2 means "over the threshold", which is this file's subject, not a broken run.
  if (failed !== 0 && failed !== 2) return failed;
  const functions = readFunctions(path.join(cwd, ".metrics", "crap.edn"));
  if (functions.size === 0) {
    process.stderr.write("census: refusing to write — the scan measured no functions\n");
    return 1;
  }
  const counts = Object.fromEntries(
    [...functions].map(([key, value]) => [key, value.complexity]).sort(([left], [right]) => left.localeCompare(right)),
  );
  const histogram = {};
  for (const complexity of Object.values(counts)) {
    histogram[complexity] = (histogram[complexity] ?? 0) + 1;
  }
  writeFileSync(
    path.resolve(cwd, options.ccBaseline),
    `${JSON.stringify({ total: Object.keys(counts).length, byComplexity: histogram, counts }, null, 2)}\n`,
  );
  const over = Object.values(counts).filter((complexity) => complexity > NEW_FUNCTION_CC_LIMIT).length;
  process.stdout.write(
    `census: wrote ${Object.keys(counts).length} functions to ${options.ccBaseline} ` +
      `(${over} of them above ${NEW_FUNCTION_CC_LIMIT}, recorded as already known)\n`,
  );
  return 0;
}

/** The nightly verdict: full scan, compare, write JSON. Exit 0 unless the scan broke. *//** The nightly verdict: full scan, compare, write JSON. Exit 0 unless the scan broke. */
export function driftStep(options, ub, cwd = process.cwd()) {
  const full = { ...options, changed: false };
  clearMetrics(cwd);
  const failed = runLayers(ub, full, cwd);
  const metricsPath = path.join(cwd, ".metrics", "crap.edn");
  // Exit 2 means "scores are over the threshold" — that is the ledger's subject, not
  // a broken run. A repo with a frozen baseline always exits 2 on a full scan, so
  // reading the code here would report every nightly run as infrastructure.
  const broke = failed !== 0 && failed !== 2;
  if (broke) return driftVerdict(options, cwd, { error: `gate: layer exited ${failed}` }, 1);
  if (!existsSync(metricsPath)) {
    return driftVerdict(options, cwd, { error: "metrics file missing after a full scan" }, 1);
  }
  const baseline = readBaseline(path.resolve(cwd, options.baseline));
  if (!baseline) {
    return driftVerdict(options, cwd, { error: `baseline missing at ${options.baseline}` }, 1);
  }
  const report = driftBetween(readScores(metricsPath), baseline, Number(options.threshold));
  return driftVerdict(options, cwd, { report }, 0);
}

function dropUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function driftVerdict(options, cwd, { report, error }, status) {
  const payload = driftPayload({
    ...(report ? { report } : {}),
    ...(error ? { error } : {}),
    threshold: Number(options.threshold),
    baseline: options.baseline,
    provenance: provenance({ ub: options.ub, cwd, env: process.env }),
  });
  writeDriftReport(options.driftReport, payload, cwd);
  process.stdout.write(
    `drift: ${payload.kind} new=${payload.counts.new} worse=${payload.counts.worse} ` +
      `fixed=${payload.counts.fixed}${error ? ` error=${error}` : ""}\n`,
  );
  return status;
}

const invokedDirectly = isMainModule(import.meta.url, process.argv[1]);
if (invokedDirectly) {
  process.exit(main());
}
