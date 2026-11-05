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
 * Modes: `existing` reads the report the ledger would read (single worker, the refresh
 * caliber); `self` lets crapper collect its own coverage in parallel, which is kept only
 * to expose collection-caliber differences — it is diagnostic, not the daily path.
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
import { isMainModule } from "./lib/is-main-module.mjs";

const USAGE = `usage: node scripts/coverage-caliber-report.mjs --self-check
       node scripts/coverage-caliber-report.mjs [--repeats N] [--modes self,existing]
                                               [--keys REGEX] [--commits A[,B]]
                                               [--format md|json] [--ub PATH]`;

/** Relative and absolute bars for "this move is noise, not a difference". */
export const NOISE = { relative: 0.05, absolute: 0.5 };

const SETTERS = {
  "--repeats": (options, value) => {
    options.repeats = Number(value);
  },
  "--modes": (options, value) => {
    options.modes = value.split(",");
  },
  "--keys": (options, value) => {
    options.keys = value;
  },
  "--commits": (options, value) => {
    options.commits = value.split(",");
  },
  "--format": (options, value) => {
    options.format = value;
  },
  "--ub": (options, value) => {
    options.ub = value;
  },
};

const FLAGS = {
  "--self-check": (options) => {
    options.selfCheck = true;
  },
  "--help": (options) => {
    options.help = true;
  },
  "-h": (options) => {
    options.help = true;
  },
};

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
    const flag = FLAGS[arg];
    if (flag) {
      flag(options);
      continue;
    }
    const setter = SETTERS[arg];
    if (!setter) throw new Error(`unknown argument '${arg}'\n${USAGE}`);
    const next = argv[index + 1];
    if (!next) throw new Error(`${arg} requires a value`);
    setter(options, next);
    index += 1;
  }
  return options;
}

export function resolveUb() {
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
/**
 * `commitB` is optional: a single-commit key is classified from `modes` alone,
 * which is what the `commitB !== undefined` branch below already assumes.
 *
 * @param {{
 *   commitA: Record<string, number[]>,
 *   commitB?: Record<string, number[]>,
 *   modes: Record<string, number[]>,
 * }} input
 * @returns {"run-sensitive" | "code-changed" | "source-sensitive" | "stable"}
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

/** The fixture the self-check judges: one key per verdict it must get right. */
export function selfCheckCells() {
  return [
    { commit: "a", mode: "self", scores: new Map([["k#stable", 20]]) },
    { commit: "a", mode: "self", scores: new Map([["k#stable", 20.1]]) },
    { commit: "a", mode: "existing", scores: new Map([["k#stable", 20]]) },
    { commit: "a", mode: "self", scores: new Map([["k#noisy", 20]]) },
    { commit: "a", mode: "self", scores: new Map([["k#noisy", 40]]) },
    { commit: "a", mode: "self", scores: new Map([["k#source", 20]]) },
    { commit: "a", mode: "existing", scores: new Map([["k#source", 30]]) },
  ];
}

/** What is wrong with a self-check report, or nothing when it is trustworthy. */
export function selfCheckProblems(report, rendered, renderedAgain) {
  const verdicts = Object.fromEntries(report.rows.map((row) => [row.key, row.verdict]));
  const problems = [];
  if (verdicts["k#stable"] !== "stable") problems.push(`stable 判成 ${verdicts["k#stable"]}`);
  if (verdicts["k#noisy"] !== "run-sensitive") problems.push(`run-sensitive 判成 ${verdicts["k#noisy"]}`);
  if (verdicts["k#source"] !== "source-sensitive") {
    problems.push(`source-sensitive 判成 ${verdicts["k#source"]}`);
  }
  if (rendered !== renderedAgain) problems.push("连跑两次报告不一致");
  return problems;
}

export function selfCheck() {
  const problems = selfCheckProblems(
    buildReport(selfCheckCells()),
    renderMarkdown(buildReport(selfCheckCells())),
    renderMarkdown(buildReport(selfCheckCells())),
  );
  if (problems.length > 0) {
    process.stderr.write(`self-check FAILED:\n  ${problems.join("\n  ")}\n`);
    return 2;
  }
  process.stdout.write("self-check ok: stable / run-sensitive / source-sensitive 判定正确，报告可复现\n");
  return 0;
}

/**
 * The process boundary, behind one object. The tool's own flow (which cells it measures,
 * what it writes when two runs disagree) is then ordinary code a test can drive, instead
 * of something only a five-minute subprocess run can reach.
 */
/**
 * @typedef {Object} CaliberIO
 * @property {string} cwd
 * @property {(file: string) => string} read
 * @property {(file: string, text: string) => void} write
 * @property {(from: string, to: string) => void} copy
 * @property {(file: string) => boolean} exists
 * @property {(dir: string) => unknown} mkdirp  The caller never reads the result.
 * @property {(command: string, args: string[]) => void} run
 * @property {(command: string, args: string[]) => { status: number | null }} runTool
 *   Only the exit status is read; declaring `SpawnSyncReturns` here would demand
 *   pid/output/signal from every stand-in for fields nothing looks at.
 */

/**
 * @param {string} [cwd]
 * @returns {CaliberIO}
 */
export function defaultIO(cwd = process.cwd()) {
  return {
    cwd,
    read: (file) => readFileSync(file, "utf8"),
    write: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    },
    copy: (from, to) => {
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(from, to);
    },
    exists: (file) => existsSync(file),
    mkdirp: (dir) => mkdirSync(dir, { recursive: true }),
    // Execution is part of the boundary too: without it a test would launch the real suite.
    run: (command, args) => {
      execFileSync(command, args, { stdio: "ignore" });
    },
    runTool: (command, args) => spawnSync(command, args, { stdio: "ignore" }),
  };
}

export function main(argv = process.argv.slice(2), io = defaultIO()) {
  const parsed = parseOrReport(argv);
  if (typeof parsed === "number") return parsed;
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (parsed.selfCheck) return selfCheck();
  if (!parsed.ub) {
    process.stderr.write("ub-mode tool chain not found; pass --ub PATH\n");
    return 1;
  }
  return writeReport(parsed, io);
}

/** Bad arguments are a usage problem, not a crash: print and hand back the exit code. */
function parseOrReport(argv) {
  try {
    return parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function writeReport(options, io) {
  try {
    const report = buildReport(measureCells(options, io), { keys: options.keys });
    process.stdout.write(options.format === "json" ? asJson(report) : renderMarkdown(report));
    return 0;
  } catch (error) {
    process.stderr.write(`could not measure: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function asJson(report) {
  return `${JSON.stringify({ summary: summarize(report), rows: report.rows }, null, 2)}\n`;
}

/** Produce and score one cell per (commit, mode, repeat); keep the reports. */
export function measureCells(options, io = defaultIO()) {
  const artifactRoot = path.join(io.cwd, "target", "coverage", "caliber");
  const commits = options.commits.length > 0 ? options.commits : ["HEAD"];
  const cells = [];
  for (const commit of commits) {
    for (const mode of options.modes) {
      for (let run = 1; run <= options.repeats; run += 1) {
        const dir = path.join(artifactRoot, commit, mode, `run-${run}`);
        io.mkdirp(dir);
        const produced = produceCoverage(mode, options, io);
        io.copy(produced.lcov, path.join(dir, "lcov.info"));
        if (run > 1) keepIfDivergent(artifactRoot, commit, mode, dir, run, io);
        // Self mode already scored the run it produced; re-scoring would double the cost.
        cells.push({ commit, mode, scores: produced.scores ?? scoreLcov(options, io) });
      }
    }
  }
  return cells;
}

function canonicalLcov(io) {
  return path.join(io.cwd, "target", "coverage", "typescript", "lcov.info");
}

export function produceCoverage(mode, options, io = defaultIO()) {
  // Same command the ledger uses in existing mode: one worker, because that is what the
  // baseline is measured with. `self` lets crapper collect in parallel on purpose — it is
  // the mode kept to expose collection-caliber differences.
  const command =
    mode === "existing"
      ? ["vitest", "run", "--coverage", "--coverage.reporter=lcov", "--maxWorkers=1"]
      : undefined;
  if (command) {
    io.run("npx", command);
    if (!io.exists(canonicalLcov(io))) throw new Error("no coverage report after the run");
    return { lcov: canonicalLcov(io) };
  }
  runTool(options.ub, ["crapper", "src", "web", "scripts", "--threshold", "10"], io);
  if (!io.exists(canonicalLcov(io))) throw new Error("crapper produced no coverage report");
  return { lcov: canonicalLcov(io), scores: readMetricsScores(io) };
}

/** Two runs that covered different lines are the finding: keep both for offline diff. */
export function keepIfDivergent(root, commit, mode, dir, run, io = defaultIO()) {
  const previous = path.join(root, commit, mode, `run-${run - 1}`, "lcov.info");
  const current = path.join(dir, "lcov.info");
  if (!io.exists(previous) || !io.exists(current)) return undefined;
  const a = coverageSignature(io.read(previous));
  const b = coverageSignature(io.read(current));
  if (a === b) return undefined;
  const unstable = path.join(root, commit, mode, "unstable");
  io.copy(previous, path.join(unstable, `run-${run - 1}.lcov.info`));
  io.copy(current, path.join(unstable, `run-${run}.lcov.info`));
  process.stderr.write(`divergent coverage kept under ${path.relative(io.cwd, unstable)}\n`);
  return unstable;
}

/**
 * Exit 2 means "scores are over the threshold" — the normal outcome on this repository,
 * not a failure. Only a missing metrics file means the measurement did not happen.
 */
export function runTool(ub, args, io = defaultIO()) {
  const result = io.runTool(ub, args);
  if (result.status !== 0 && result.status !== 2) {
    throw new Error(`${path.basename(ub)} ${args[0]} exited ${result.status}`);
  }
}

function scoreLcov(options, io) {
  runTool(options.ub, ["crapper", "src", "web", "scripts", "--use-existing-coverage", "--threshold", "10"], io);
  return readMetricsScores(io);
}

function readMetricsScores(io = defaultIO()) {
  const text = io.read(path.join(io.cwd, ".metrics", "crap.edn"));
  const scores = new Map();
  for (const match of text.matchAll(/\{:name "([^"]*)", :namespace "([^"]*)", .*:crap ([\d.]+)\}/g)) {
    scores.set(`${match[2]}#${match[1]}`, Number(match[3]));
  }
  return scores;
}

const invokedDirectly = isMainModule(import.meta.url, process.argv[1]);
if (invokedDirectly) {
  process.exit(main());
}
