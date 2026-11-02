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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os, { arch, platform } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = `usage: node scripts/ub-quality-gate.mjs [--tool crapper|dryer|mutator] [--threshold N]
                                  [--rust-threshold N] [--baseline PATH] [--update-baseline]
                                  [--all] [--ub PATH] [--drift-report PATH]
                                  [--coverage-a PATH --coverage-b PATH] [-- extra args]

  --coverage-a/--coverage-b  two independently produced coverage reports. They must cover
                             the same lines for a baseline to be written (hit counts may
                             differ); a mismatch is a non-reproducible measurement, and
                             both reports are kept under target/coverage/unstable/ for
                             offline comparison.`;
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
  "--drift-report": "driftReport",
  "--coverage-a": "coverageA",
  "--coverage-b": "coverageB",
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
  return files.filter(isScoredSource);
}

/** crapper skips test paths when it walks the tree; a changed list must match. */
export function isScoredSource(file) {
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|rs)$/.test(file) === false) return false;
  return !(file.startsWith("test/") || file.includes("/e2e/") || /\.(test|spec)\.[a-z]+$/.test(file));
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

export function main(argv = process.argv.slice(2)) {
  const prepared = prepare(argv);
  if (prepared.status !== undefined) return prepared.status;
  if (prepared.options.driftReport) return driftStep(prepared.options, prepared.ub);
  clearMetrics();
  // crapper in changed mode has nothing to score when nothing changed; the
  // other tools do not look at git at all.
  if (isIdleCrapperRun(prepared.options)) return baselineStep(prepared.options);
  // Seeding a baseline records reality even when the layers are still red — but only
  // reality that repeats. See stableBaseline().
  if (prepared.options.updateBaseline) return stableBaseline(prepared.ub, prepared.options);
  const failed = runLayers(prepared.ub, prepared.options);
  return failed === 0 ? baselineStep(prepared.options) : failed;
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
  return {
    scores: readScores(path.join(cwd, ".metrics", "crap.edn")),
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
  const pairVerdict = coveragePairVerdict(options, cwd);
  if (pairVerdict !== undefined) return pairVerdict;
  const first = scanOnce(ub, options, cwd);
  // Tests only: a tamper between the scans has no other seam, because in production
  // nothing in this process can be told to act there.
  hooks.betweenScans?.();
  const second = scanOnce(ub, options, cwd);
  const refusal = scanRefusal(first, second, cwd);
  if (refusal !== undefined) return refusal;
  return writeBaseline(
    second.scores,
    path.resolve(cwd, options.baseline),
    options.baseline,
    baselineGeneration({ ub, cwd, first, second }),
  );
}

/** Existing mode only: the two input reports must agree before anything is scored. */
function coveragePairVerdict(options, cwd) {
  if (!usesExistingCoverage(options)) return undefined;
  const pair = requireReproducibleCoverage(options, cwd);
  return pair.status;
}

/** Everything that makes two scans unusable as a baseline, or nothing. */
function scanRefusal(first, second, cwd) {
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

export function baselineGeneration({ ub, cwd = process.cwd(), first, second }) {
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
export function driftBetween(scores, baseline, threshold = 10) {
  return sortDrift({
    ...debtSince(scores, baseline, threshold),
    fixed: paidDebt(scores, baseline, threshold),
  });
}

/** Debt that appeared, and debt that grew; both already over the threshold. */
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
function paidDebt(scores, baseline, threshold) {
  const fixed = [];
  for (const [key, frozen] of Object.entries(baseline)) {
    const score = scores.get(key);
    if (score === undefined || score <= threshold) fixed.push({ key, frozen });
  }
  return fixed;
}

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
 * The file the nightly workflow reads. `kind` is the whole point: an infrastructure
 * failure (missing tool chain, crashed scan, absent baseline) is not a ledger with
 * three zero counters, and must never be reported as "clean".
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
    withinNoise: verdict.withinNoise ?? [],
  };
}

export function writeDriftReport(pathname, payload, cwd = process.cwd()) {
  const target = path.resolve(cwd, pathname);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
  return target;
}

/** The nightly verdict: full scan, compare, write JSON. Exit 0 unless the scan broke. */
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

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  process.exit(main());
}
