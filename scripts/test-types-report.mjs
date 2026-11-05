#!/usr/bin/env node
/**
 * Hold the number of type errors in the test project at or below a frozen count.
 *
 * `pnpm check` type-checks `src/` and `web/src/`. Neither project includes
 * `test/`, so twenty-plus batches of work on the test tree left 139 errors that
 * no pipeline step could see: a new test file could add thirty more and CI
 * stayed green. This is the ledger that closes that hole. It protects the work
 * already done; it does not replace it.
 *
 * Three rules, all of them, because each refuses a different evasion:
 *
 *   1. the total may not exceed the frozen total;
 *   2. no file may exceed its own frozen count;
 *   3. a file absent from the baseline is capped at zero.
 *
 * Rule 3 is what makes this a gate instead of a budget. Without it, adding a
 * file with thirty errors is invisible as long as some other file happens to
 * shrink by thirty — the total would look right while the debt moved to a place
 * nobody was watching. A budget that can be spent elsewhere is not a cap.
 *
 * The baseline moves in one direction. `--update-baseline` recomputes the
 * numbers after work has landed, and it refuses if any file grew: an allowance
 * must be named on the command line with its reason, `--allow-increase=<file>,
 * <reason>`, and that reason is written into the baseline. A refresh that can
 * silently raise a number is the laundering channel every gate eventually grows.
 * The reason is not consulted by the check — it is an audit trail explaining why
 * that file's number is what it is, and it disappears as soon as the number falls,
 * because the number it was written for is gone.
 *
 * Two honest limits. The first baseline is a measurement, not an allowance:
 * with no file to compare against there is nothing to lower, so it records what
 * is there today. And deleting the file re-measures instead of lowering — that
 * is the one way to launder a number here, and it shows up as a deleted file in
 * the diff, where review can see it.
 *
 * Errors printed with no source position — a broken tsconfig, no inputs found —
 * are not counted by the parser, and a gate that reads that as "zero errors"
 * would be green while checking nothing. They are reported and failed instead.
 *
 * The entry guard is `lib/is-main-module.mjs`, for the reason written there: this
 * file first compared `import.meta.url` with a URL built from `argv[1]`, and from
 * a temporary directory that comparison is false for the very same file.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/is-main-module.mjs";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultBaseline = path.join(defaultRoot, ".test-types-baseline.json");
const defaultProject = "tsconfig.test.json";

/**
 * A positioned diagnostic, the only format `tsc --pretty false` emits for a
 * source file: `test/a.test.ts(12,7): error TS2322: …`. Anchored, so the
 * indented "Types of property …" continuation lines never match.
 */
const positioned = /^(.+?)\((\d+),(\d+)\): error (TS\d+):/;

/** A diagnostic printed with no file and no position: the project itself failed. */
const positionless = /^error TS\d+:/;

/**
 * @typedef {{ file: string, line: number, code: string }} Diagnostic
 * @typedef {{ total: number, counts: Record<string, number>, allowedIncreases?: Record<string, string> }} Baseline
 */

/**
 * Every positioned diagnostic in a compiler run, in the order printed.
 * @param {string} output
 * @returns {Diagnostic[]}
 */
export function parseDiagnostics(output) {
  const diagnostics = [];
  for (const line of output.split("\n")) {
    const match = positioned.exec(line);
    if (match) diagnostics.push({ file: match[1], line: Number(match[2]), code: match[4] });
  }
  return diagnostics;
}

/**
 * Lines reporting an error that belongs to no source file. A non-empty answer
 * means the test project did not type-check at all, so the count below it is
 * meaningless — the check must fail rather than read zero and pass.
 * @param {string} output
 * @returns {string[]}
 */
export function unpositionedErrors(output) {
  return output.split("\n").filter((line) => positionless.test(line));
}

/**
 * @param {string[]} values
 * @returns {Record<string, number>}
 */
function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/**
 * Errors per file. Counting per file rather than per line keeps the comparison
 * stable while edits move lines around, which is the point of a ledger that
 * outlives the code it describes.
 * @param {Diagnostic[]} diagnostics
 * @returns {Record<string, number>}
 */
export function countByFile(diagnostics) {
  return countBy(diagnostics.map((diagnostic) => diagnostic.file));
}

/**
 * @param {Record<string, number>} counts
 * @returns {number}
 */
export function sumCounts(counts) {
  let total = 0;
  for (const count of Object.values(counts)) total += count;
  return total;
}

/**
 * Rule 1. While a baseline's per-file counts agree with its total, this is
 * implied by rules 2 and 3 — and that redundancy is the point. The total is the
 * number a person reads and therefore the number someone edits by hand when a
 * gate is inconvenient: lower it alone and rules 2 and 3 still pass on a ledger
 * that no longer describes anything, while this one refuses and the report names
 * the disagreement underneath.
 * @param {number} count
 * @param {Baseline} baseline
 */
export function totalViolation(count, baseline) {
  if (count <= baseline.total) return [];
  return [{ kind: "total", key: "total", allowed: baseline.total, count }];
}

/**
 * What one file would break, or nothing when it is within its cap. A file the
 * baseline has never seen is a file capped at zero; `kind` keeps the two apart
 * because "0 -> 3" means something different on a stranger than on a file that
 * was cleaned last week.
 * @param {Baseline} baseline
 * @param {string} file
 * @param {number} count
 */
function violationFor(baseline, file, count) {
  const known = Object.hasOwn(baseline.counts, file);
  const allowed = known ? baseline.counts[file] : 0;
  if (count <= allowed) return undefined;
  return { kind: known ? "file" : "new-file", key: file, allowed, count };
}

/**
 * Rules 2 and 3, in one pass because they are one comparison: a file absent from
 * the baseline is a file allowed zero. `kind` separates them in the report —
 * "0 -> 3" on a file nobody has seen before deserves a different sentence than
 * "0 -> 3" on a file that was cleaned last week.
 * @param {Record<string, number>} counts
 * @param {Baseline} baseline
 */
export function fileViolations(counts, baseline) {
  const violations = [];
  for (const [file, count] of Object.entries(counts)) {
    const violation = violationFor(baseline, file, count);
    if (violation) violations.push(violation);
  }
  return violations.sort((left, right) => right.count - left.count);
}

/**
 * @param {Diagnostic[]} diagnostics
 * @param {Baseline} baseline
 */
export function compareToBaseline(diagnostics, baseline) {
  const counts = countByFile(diagnostics);
  return [...totalViolation(diagnostics.length, baseline), ...fileViolations(counts, baseline)];
}

/**
 * Whether a value is a non-null object. One shape per function: two `&&` in one
 * expression is already more than the complexity allowance wants to see.
 * @param {unknown} value
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * Whether a parsed file has the shape this gate can read. A ledger that cannot
 * be read is reported rather than thrown: a stack trace in CI hides the one
 * sentence the reader needs — which file, and what was expected instead.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBaseline(value) {
  if (!isRecord(value)) return false;
  if (typeof value.total !== "number") return false;
  return isRecord(value.counts);
}


/**
 * The number this file was frozen at. Absent means zero: rule 3, in one line.
 * @param {Baseline} previous
 * @param {string} file
 */
function countBefore(previous, file) {
  return previous.counts[file] ?? 0;
}

/** Reasons carried from the previous baseline; a hand-written one may hold none. */
function carriedReasons(baseline) {
  return baseline.allowedIncreases ?? {};
}

/**
 * Whether a file may keep its number: everything that did not rise, plus a rise
 * somebody has already named.
 */
function admits(count, before, reason) {
  return count <= before || Boolean(reason);
}

/**
 * The reason that applies to a file this run. An explicit one wins; otherwise the
 * previous reason still applies only while the number has not moved. A rise needs
 * its own reason — carrying an old one forward would let a number climb one
 * refresh at a time under a justification written for a different number — and a
 * fall needs none, because the reason explained the higher number and that number
 * is gone.
 * @param {string} file
 * @param {number} count
 * @param {number} before
 * @param {Record<string, string>} carried
 * @param {Record<string, string>} reasons
 */
function reasonFor(file, count, before, carried, reasons) {
  if (reasons[file]) return reasons[file];
  if (count !== before) return undefined;
  return carried[file];
}

/**
 * The baseline the admitted files add up to, carrying the reasons that still
 * explain something. A reason for a number that fell is dropped here, which is
 * why the audit trail cannot outlive the debt it explains.
 * @param {{ file: string, count: number }[]} kept
 * @param {Baseline} previous
 * @param {Record<string, string>} reasons
 */
function frozenFrom(kept, previous, reasons) {
  const counts = {};
  const allowedIncreases = {};
  const carried = carriedReasons(previous);
  for (const { file, count } of kept) {
    counts[file] = count;
    const reason = reasonFor(file, count, countBefore(previous, file), carried, reasons);
    if (reason) allowedIncreases[file] = reason;
  }
  return { total: sumCounts(counts), counts, allowedIncreases };
}

/**
 * The next baseline. Every file may fall; a file may rise only where a reason
 * was named.
 *
 * `rejected` is returned rather than thrown so the caller can print every
 * offending file at once instead of one per run.
 * @param {Baseline} previous
 * @param {Record<string, number>} counts
 * @param {Record<string, string>} reasons
 */
export function freezeBaseline(previous, counts, reasons) {
  const kept = [];
  const rejected = [];
  for (const [file, count] of Object.entries(counts)) {
    const before = countBefore(previous, file);
    if (admits(count, before, reasons[file])) kept.push({ file, count });
    else rejected.push({ file, before, count });
  }
  return { baseline: frozenFrom(kept, previous, reasons), rejected };
}

/**
 * `--allow-increase=<file>,<reason>`. The comma after the path is the first one:
 * reasons are prose and may contain commas of their own.
 * @param {string} argument
 */
export function decodeAllowance(argument) {
  const body = argument.slice(argument.indexOf("=") + 1);
  const comma = body.indexOf(",");
  const file = comma === -1 ? body : body.slice(0, comma);
  const reason = comma === -1 ? "" : body.slice(comma + 1).trim();
  return { file, reason };
}

/**
 * Every `--allow-increase` on the command line, keyed by file. A reason with no
 * text is refused here rather than written as an empty string, because an
 * allowance whose justification is blank is an allowance nobody justified.
 * @param {string[]} args
 */
export function readAllowances(args) {
  const reasons = {};
  for (const argument of args.filter((arg) => arg.startsWith("--allow-increase="))) {
    const { file, reason } = decodeAllowance(argument);
    if (!reason) throw new Error(`${argument} needs a reason after the comma.`);
    reasons[file] = reason;
  }
  return reasons;
}

/** @param {number} count */
function column(count) {
  return String(count).padStart(4);
}

/**
 * @param {Record<string, number>} counts
 */
function bySize(counts) {
  return Object.entries(counts).sort((left, right) => right[1] - left[1]);
}

/**
 * The full picture, for a person deciding what to clean next.
 * @param {Diagnostic[]} diagnostics
 */
export function formatReport(diagnostics) {
  const files = bySize(countByFile(diagnostics));
  const codes = bySize(countBy(diagnostics.map((diagnostic) => diagnostic.code)));
  const lines = [`${diagnostics.length} test type error(s) in ${files.length} file(s)`, "", "by code:"];
  for (const [code, count] of codes) lines.push(`  ${column(count)}  ${code}`);
  lines.push("", "by file:");
  for (const [file, count] of files) lines.push(`  ${column(count)}  ${file}`);
  return `${lines.join("\n")}\n`;
}

/**
 * @param {{ kind: string, key: string, allowed: number, count: number }[]} violations
 * @param {Diagnostic[]} diagnostics
 * @param {Baseline} baseline
 */
/** The lines naming where each error in one file sits. */
function positions(file, diagnostics) {
  return diagnostics
    .filter((one) => one.file === file)
    .map((one) => `    ${one.file}:${one.line} ${one.code}`);
}

/**
 * One violation as its own lines. `kind` decides the sentence, because a growth
 * on a file nobody has seen before is a different event from a growth on a file
 * that was cleaned, and the note is what tells them apart.
 * @param {{ kind: string, key: string, allowed: number, count: number }} violation
 * @param {Diagnostic[]} diagnostics
 */
function formatOne(violation, diagnostics) {
  const { kind, key, allowed, count } = violation;
  const note = kind === "new-file" ? " (new file: absent from the baseline)" : "";
  const head = `  ${key}: ${allowed} -> ${count}${note}`;
  if (kind === "total") return [head];
  return [head, ...positions(key, diagnostics)];
}

/** A baseline whose total disagrees with its own counts, said in one line. */
function mismatchLines(baseline) {
  const sum = sumCounts(baseline.counts);
  if (sum === baseline.total) return [];
  return [
    `  the baseline disagrees with itself: its per-file counts sum to ${sum}, its total says ${baseline.total}`,
  ];
}

export function formatViolations(violations, diagnostics, baseline) {
  const lines = [`test type errors grew: ${violations.length} violation(s) over baseline`];
  for (const violation of violations) lines.push(...formatOne(violation, diagnostics));
  return `${[...lines, ...mismatchLines(baseline)].join("\n")}\n`;
}

/**
 * @param {string[]} args
 * @param {string} flag
 * @param {string} fallback
 */
export function option(args, flag, fallback) {
  const at = args.indexOf(flag);
  if (at === -1) return fallback;
  const value = args[at + 1];
  // A flag with nothing after it would otherwise reach path.resolve as
  // `undefined` and fail with a message about the wrong thing entirely.
  if (!value) throw new Error(`${flag} needs a value.`);
  return value;
}

/**
 * Compile the given project and return everything the compiler printed. A
 * non-zero exit is expected — errors are the thing being measured — so only a
 * failure to start the compiler is an exception.
 * @param {string} project absolute path to the tsconfig
 * @param {string} cwd
 */
export function runTsc(project, cwd) {
  const compiler = path.join(path.dirname(createRequire(import.meta.url).resolve("typescript")), "tsc.js");
  const run = spawnSync(process.execPath, [compiler, "-p", project, "--noEmit", "--pretty", "false"], {
    cwd,
    encoding: "utf8",
  });
  // A failed spawn is the only way stdout or stderr is null, and that is the
  // line above — so after it, both are strings and appending them is enough.
  if (run.error) throw run.error;
  return `${run.stdout}${run.stderr}`;
}

/**
 * @param {string} baselinePath
 * @returns {Baseline}
 */
export function loadBaseline(baselinePath) {
  if (!existsSync(baselinePath)) {
    throw new Error(
      `No baseline at ${baselinePath}. Run with --update-baseline once to measure it.`,
    );
  }
  const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (!isBaseline(parsed)) {
    throw new Error(
      `${baselinePath} is not a baseline: expected { "total": number, "counts": { "<file>": number } }.`,
    );
  }
  return parsed;
}

/**
 * @param {string} baselinePath
 * @param {Baseline} baseline
 */
function writeBaseline(baselinePath, baseline) {
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
}

/**
 * @param {{ file: string, before: number, count: number }[]} rejected
 */
export function formatRejections(rejected) {
  const lines = [`refusing to raise ${rejected.length} file(s): the baseline only goes down`];
  for (const { file, before, count } of rejected) {
    lines.push(`  ${file}: ${before} -> ${count}   needs --allow-increase=${file},<reason>`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Re-measure. With no previous file there is nothing to lower, so the first run
 * records what is there; after that every rise needs its name and reason.
 *
 * The outcome is returned as text and a verdict instead of ending the process:
 * a function that calls `exit` is a function no test can call, and this one has
 * three branches that are worth checking one by one.
 * @param {string[]} args
 * @param {Diagnostic[]} diagnostics
 * @param {string} baselinePath
 */
export function updateBaseline(args, diagnostics, baselinePath) {
  const counts = countByFile(diagnostics);
  // No file yet means there is no earlier number to lower: today's measurement
  // becomes the floor. Comparing against an empty baseline would instead refuse
  // every file as a rise, which reads as a bug and would push the first user to
  // write counts by hand.
  const previous = existsSync(baselinePath) ? loadBaseline(baselinePath) : { total: 0, counts };
  const { baseline, rejected } = freezeBaseline(previous, counts, readAllowances(args));
  if (rejected.length > 0) return { ok: false, report: formatRejections(rejected) };
  writeBaseline(baselinePath, baseline);
  const files = Object.keys(baseline.counts).length;
  return {
    ok: true,
    report: `wrote ${baseline.total} error(s) in ${files} file(s) to ${baselinePath}\n`,
  };
}

/**
 * @param {Diagnostic[]} diagnostics
 * @param {string} baselinePath
 */
export function checkBaseline(diagnostics, baselinePath) {
  const baseline = loadBaseline(baselinePath);
  const violations = compareToBaseline(diagnostics, baseline);
  if (violations.length > 0) {
    return { ok: false, report: formatViolations(violations, diagnostics, baseline) };
  }
  const files = Object.keys(countByFile(diagnostics)).length;
  return {
    ok: true,
    report: `${diagnostics.length} test type error(s) in ${files} file(s), none added\n`,
  };
}

/**
 * Which of the three modes the arguments ask for. Apart from the entry block so
 * that each mode is reachable from a test in this process — a spawned child has
 * no coverage, and a gate nobody has measured is a gate nobody knows the cost of.
 * @param {string[]} args
 * @param {Diagnostic[]} diagnostics
 * @param {string} baselinePath
 */
export function run(args, diagnostics, baselinePath) {
  if (args.includes("--update-baseline")) return updateBaseline(args, diagnostics, baselinePath);
  if (args.includes("--check")) return checkBaseline(diagnostics, baselinePath);
  return { ok: true, report: formatReport(diagnostics) };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const args = process.argv.slice(2);
  const project = path.resolve(defaultRoot, option(args, "--project", defaultProject));
  const baselinePath = path.resolve(defaultRoot, option(args, "--baseline", defaultBaseline));
  const output = runTsc(project, defaultRoot);

  // Before anything is counted: an error with no source position means the
  // project itself did not compile, and the count below it would read as zero
  // errors from a run that checked nothing.
  const unpositioned = unpositionedErrors(output);
  if (unpositioned.length > 0) {
    process.stderr.write(
      `the test project did not type-check: ${unpositioned.length} error(s) with no source position\n`,
    );
    for (const line of unpositioned) process.stderr.write(`  ${line}\n`);
    process.exit(1);
  }

  const result = run(args, parseDiagnostics(output), baselinePath);
  if (!result.ok) {
    process.stderr.write(result.report);
    process.exit(1);
  }
  process.stdout.write(result.report);
}
