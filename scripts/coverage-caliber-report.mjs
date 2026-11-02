#!/usr/bin/env node
/**
 * Why did this number change?
 *
 * A CRAP score moves for exactly three reasons: the code changed, the way coverage was
 * produced changed, or the run itself was noisy. This script separates them by measuring
 * every combination and classifying each function, instead of leaving a human to diff
 * lcov files by hand (which is what the last three rounds of debugging cost).
 *
 * It **explains** the guard; it is not a guard.
 *   - it never fails because a difference was found;
 *   - it never writes a baseline and never opens an issue;
 *   - do not wire it into CI as a merge gate. The gate is `ub-quality-gate.mjs`.
 *
 * Exit codes mean only "did the measurement happen":
 *   0  report produced (whatever it says)
 *   1  could not measure (missing tool chain, a producer crashed)
 *   2  --self-check failed: the report itself is not trustworthy
 *
 * Usage:
 *   node scripts/coverage-caliber-report.mjs --self-check
 *   node scripts/coverage-caliber-report.mjs [--repeats 8] [--modes self,existing]
 *                                            [--keys REGEX] [--commits A[,B]]
 *                                            [--format md|json] [--ub PATH]
 *
 * Cost: each (commit × mode × repeat) cell runs the suite once to produce coverage and
 * once to score it. The default 1 commit × 2 modes × 8 repeats is ~5 minutes of test
 * time — deliberately more than a K=2 spot check, because a 1-in-7 event is invisible
 * at K=2 and the whole point is to stop re-catching it live.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = `usage: node scripts/coverage-caliber-report.mjs --self-check
       node scripts/coverage-caliber-report.mjs [--repeats N] [--modes self,existing]
                                               [--keys REGEX] [--commits A[,B]]
                                               [--format md|json] [--ub PATH]`;

/** Relative and absolute bars for "this move is noise, not a difference". */
export const NOISE = { relative: 0.05, absolute: 0.5 };

export function parseArgs(argv, env = process.env) {
  const options = {
    repeats: 8,
    modes: ["self", "existing"],
    keys: "",
    commits: [],
    format: "md",
    ub: env.UB_BIN?.trim() || resolveUb(),
    selfCheck: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === "--help" || arg === "-h") return { ...options, help: true };
    else if (arg === "--self-check") options.selfCheck = true;
    else if (arg === "--repeats") options.repeats = Number(value());
    else if (arg === "--modes") options.modes = value().split(",");
    else if (arg === "--keys") options.keys = value();
    else if (arg === "--commits") options.commits = value().split(",");
    else if (arg === "--format") options.format = value();
    else if (arg === "--ub") options.ub = value();
    else throw new Error(`unknown argument '${arg}'\n${USAGE}`);
  }
  return options;
}

function resolveUb() {
  const candidates = [".kimi-code", ".agents"].map((home) =>
    path.join(os.homedir(), home, "tools", "ub", "ub"),
  );
  return candidates.find((candidate) => existsSync(candidate)) ?? "";
}

/** The covered-line-set digest: what CRAP consumes, unlike raw lcov bytes. */
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

function withinNoise(before, after) {
  const relative = Math.abs(after - before) / Math.max(before, after, 1);
  return relative <= NOISE.relative || Math.abs(after - before) <= NOISE.absolute;
}

/**
 * One verdict per function, from its values per mode across repeats.
 *
 *   code-changed      the two commits differ, in the same mode
 *   source-sensitive  the modes differ, each stable on its own
 *   run-sensitive     repeats inside one mode disagree
 *   stable            everything agrees
 */
export function classifyKey({ commitA, commitB, modes }) {
  const same = (values) => values.every((value) => withinNoise(values[0], value));
  const runSensitive = Object.values(modes).some((values) => values.length > 1 && !same(values));
  if (runSensitive) return "run-sensitive";
  if (commitB !== undefined) {
    const [a, b] = [commitA, commitB];
    const names = Object.keys(a);
    const moved = names.some((name) => !withinNoise(a[name][0], b[name][0]));
    if (moved) return "code-changed";
  }
  const names = Object.keys(modes);
  if (names.length > 1 && !withinNoise(modes[names[0]][0], modes[names[1]][0])) {
    return "source-sensitive";
  }
  return "stable";
}

/**
 * The report model: rows of {key, perMode, perCommit, verdict}. Pure, so the self-check
 * can assert it without running a single test.
 */
export function buildReport(measurements, { keys } = {}) {
  const filter = keys ? new RegExp(keys) : undefined;
  const byKey = new Map();
  for (const cell of measurements) {
    for (const [key, value] of cell.scores) {
      if (filter && !filter.test(key)) continue;
      const entry = byKey.get(key) ?? { key, perCommit: {}, commitB: undefined };
      const forCommit = (entry.perCommit[cell.commit] ??= {});
      (forCommit[cell.mode] ??= []).push(value);
      byKey.set(key, entry);
    }
  }
  const rows = [...byKey.values()]
    .map((entry) => ({
      key: entry.key,
      perCommit: entry.perCommit,
      verdict: classifyKey({
        commitA: entry.perCommit[Object.keys(entry.perCommit)[0]],
        ...(Object.keys(entry.perCommit)[1] ? { commitB: entry.perCommit[Object.keys(entry.perCommit)[1]] } : {}),
        modes: entry.perCommit[Object.keys(entry.perCommit)[0]],
      }),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  return { rows, generatedAt: "fixed-for-determinism" };
}

const fmt = (value) => (typeof value === "number" ? value.toFixed(2) : String(value ?? "?"));

/** Deterministic markdown: same model in, same bytes out. */
export function renderMarkdown(report) {
  const header = ["key", "verdict", "values"];
  const lines = [
    "| key | verdict | values |",
    "| --- | --- | --- |",
    ...report.rows.map((row) => {
      const values = Object.entries(row.perCommit)
        .map(([commit, modes]) =>
          Object.entries(modes)
            .map(([mode, runs]) => `${commit}/${mode}: ${runs.map(fmt).join(" · ")}`)
            .join(" | "),
        )
        .join(" | ");
      return `| ${row.key} | ${row.verdict} | ${values} |`;
    }),
  ];
  void header;
  return `${lines.join("\n")}\n`;
}

/** Counts by verdict, for the summary line at the top of the report. */
export function summarize(report) {
  const counts = { stable: 0, "run-sensitive": 0, "source-sensitive": 0, "code-changed": 0 };
  for (const row of report.rows) counts[row.verdict] += 1;
  return counts;
}

function selfCheck() {
  const stable = [
    { commit: "a", mode: "self", scores: new Map([["k#stable", 20]]) },
    { commit: "a", mode: "self", scores: new Map([["k#stable", 20.1]]) },
    { commit: "a", mode: "existing", scores: new Map([["k#stable", 20]]) },
    { commit: "a", mode: "self", scores: new Map([["k#noisy", 20]]) },
    { commit: "a", mode: "self", scores: new Map([["k#noisy", 40]]) },
    { commit: "a", mode: "self", scores: new Map([["k#source", 20]]) },
    { commit: "a", mode: "existing", scores: new Map([["k#source", 30]]) },
  ];
  const report = buildReport(stable);
  const verdicts = Object.fromEntries(report.rows.map((row) => [row.key, row.verdict]));
  const problems = [];
  if (verdicts["k#stable"] !== "stable") problems.push(`stable 判成 ${verdicts["k#stable"]}`);
  if (verdicts["k#noisy"] !== "run-sensitive") problems.push(`run-sensitive 判成 ${verdicts["k#noisy"]}`);
  if (verdicts["k#source"] !== "source-sensitive") problems.push(`source-sensitive 判成 ${verdicts["k#source"]}`);
  const once = renderMarkdown(report);
  const twice = renderMarkdown(buildReport(stable));
  if (once !== twice) problems.push("连跑两次报告不一致");
  if (problems.length > 0) {
    process.stderr.write(`self-check FAILED:\n  ${problems.join("\n  ")}\n`);
    return 2;
  }
  process.stdout.write("self-check ok: stable / run-sensitive / source-sensitive 判定正确，报告可复现\n");
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (options.selfCheck) return selfCheck();
  if (!options.ub) {
    process.stderr.write("ub-mode tool chain not found; pass --ub PATH\n");
    return 1;
  }
  try {
    const measurements = measureCells(options);
    const report = buildReport(measurements, { keys: options.keys });
    const body =
      options.format === "json"
        ? `${JSON.stringify({ summary: summarize(report), rows: report.rows }, null, 2)}\n`
        : renderMarkdown(report);
    process.stdout.write(body);
    return 0;
  } catch (error) {
    process.stderr.write(`could not measure: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** Produce and score one cell per (commit, mode, repeat); keep the reports. */
function measureCells(options) {
  const artifactRoot = path.join(process.cwd(), "target", "coverage", "caliber");
  const commits = options.commits.length > 0 ? options.commits : ["HEAD"];
  const measurements = [];
  for (const commit of commits) {
    for (const mode of options.modes) {
      for (let run = 1; run <= options.repeats; run += 1) {
        const dir = path.join(artifactRoot, commit, mode, `run-${run}`);
        mkdirSync(dir, { recursive: true });
        const produced = produceCoverage(mode, options.ub, dir);
        copyFileSync(produced.lcov, path.join(dir, "lcov.info"));
        if (run > 1) keepIfDivergent(artifactRoot, commit, mode, dir, run);
        // Self mode already scored the run it just produced; re-scoring would double the
        // cost without adding information.
        measurements.push({ commit, mode, scores: produced.scores ?? scoreLcov(options.ub) });
      }
    }
  }
  return measurements;
}

function produceCoverage(mode, ub, dir) {
  const lcov = path.join(process.cwd(), "target", "coverage", "typescript", "lcov.info");
  if (mode === "existing") {
    execFileSync("npx", ["vitest", "run", "--coverage", "--coverage.reporter=lcov"], { stdio: "ignore" });
    if (!existsSync(lcov)) throw new Error(`no coverage report after the run (${dir})`);
    return { lcov };
  }
  runTool(ub, ["crapper", "src", "web", "scripts", "--threshold", "10"]);
  const produced = path.join(process.cwd(), "target", "coverage", "typescript", "lcov.info");
  if (!existsSync(produced)) throw new Error("crapper produced no coverage report");
  return { lcov: produced, scores: readMetricsScores() };
}

/** Two runs that covered different lines are a finding: keep both for offline diff. */
function keepIfDivergent(root, commit, mode, dir, run) {
  const previous = path.join(root, commit, mode, `run-${run - 1}`, "lcov.info");
  const current = path.join(dir, "lcov.info");
  if (!existsSync(previous)) return;
  const a = coverageSignature(readFileSync(previous, "utf8"));
  const b = coverageSignature(readFileSync(current, "utf8"));
  if (a === b) return;
  const unstable = path.join(root, commit, mode, "unstable");
  mkdirSync(unstable, { recursive: true });
  writeFileSync(path.join(unstable, `run-${run - 1}.lcov.info`), readFileSync(previous));
  writeFileSync(path.join(unstable, `run-${run}.lcov.info`), readFileSync(current));
  process.stderr.write(`divergent coverage kept under ${path.relative(process.cwd(), unstable)}\n`);
}

/**
 * Exit 2 means "scores are over the threshold" — the normal outcome on this repository,
 * not a failure. Only a missing metrics file means the measurement did not happen.
 */
function runTool(ub, args) {
  const result = spawnSync(ub, args, { stdio: "ignore" });
  if (result.status !== 0 && result.status !== 2) {
    throw new Error(`${path.basename(ub)} ${args[0]} exited ${result.status}`);
  }
}

function scoreLcov(ub) {
  runTool(ub, ["crapper", "src", "web", "scripts", "--use-existing-coverage", "--threshold", "10"]);
  return readMetricsScores();
}

function readMetricsScores() {
  const text = readFileSync(path.join(process.cwd(), ".metrics", "crap.edn"), "utf8");
  const scores = new Map();
  for (const match of text.matchAll(/\{:name "([^"]*)", :namespace "([^"]*)", .*:crap ([\d.]+)\}/g)) {
    scores.set(`${match[2]}#${match[1]}`, Number(match[3]));
  }
  return scores;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  process.exit(main());
}
