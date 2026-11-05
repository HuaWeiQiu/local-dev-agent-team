#!/usr/bin/env node
/**
 * Why did the ledger grow?
 *
 * The nightly guard answers *whether* the ledger grew. This answers *why*, for the entries
 * that grew, by re-measuring exactly those keys and asking one question per key: does the
 * same command produce the same score again?
 *
 * It is an explanation, not a guard, and the difference is the whole design:
 *   - it runs only when the ledger actually reported `new > 0`; a quiet ledger costs nothing;
 *   - it never fails the nightly. A measurement that did not happen is written into the
 *     artifact as `status: "failed"` and shown in the issue as one line, because a red X on
 *     a job that only explains things teaches people to ignore red Xs;
 *   - it never writes a baseline, never opens an issue of its own, and never becomes a
 *     merge gate. The gate is `ub-quality-gate.mjs`.
 *
 * Three repeats, one mode, on purpose:
 *   - `existing` is the caliber the ledger's numbers come from, so the comparison is
 *     apples to apples; `self` collects coverage in parallel and would only re-introduce
 *     the noise this is trying to see;
 *   - K=3 because this is attribution, not judgement. Two samples agreeing is how a
 *     coincidence gets mistaken for a guarantee; five is the price of a verdict, which
 *     this is not.
 *
 * `--keys` does not make the run cheaper — every cell still runs the whole suite — it only
 * bounds the report to the keys that actually moved. The cost of a nightly with new debt is
 * therefore three full runs of the suite, which is the reason the step is gated on `new > 0`
 * rather than run every night.
 *
 * Usage:
 *   node scripts/coverage-caliber-attribution.mjs drift-report.json [caliber-attribution.json]
 *                                                  [--ub PATH]
 *
 * Exit codes mean only "did the artifact get written": 0 whenever the model was written
 * (measured, skipped or failed inside it), 1 for a usage error. A difference found is not a
 * failure and produces exit 0 like everything else.
 */

import { NOISE, buildReport, defaultIO, measureCells, resolveUb } from "./coverage-caliber-report.mjs";
import { readReport } from "./drift-report.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

export const REPEATS = 3;
export const MODES = ["existing"];

const USAGE = `usage: node scripts/coverage-caliber-attribution.mjs <drift-report.json>
              [caliber-attribution.json] [--ub PATH]`;

const DEFAULTS = { report: "", out: "caliber-attribution.json" };

export function parseArgs(argv, env = process.env) {
  const options = { ...DEFAULTS, ub: envUb(env) };
  const positional = [];
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { ...options, help: true };
    if (arg === "--ub") {
      options.ub = valueAt(argv, index);
      index += 2;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown argument '${arg}'\n${USAGE}`);
    positional.push(arg);
    index += 1;
  }
  return { ...options, report: positional[0] ?? "", out: positional[1] ?? options.out };
}

/** Where the tool chain comes from: the environment first, then the usual install paths. */
function envUb(env) {
  return env.UB_BIN?.trim() || resolveUb();
}

function valueAt(argv, index) {
  const next = argv[index + 1];
  if (!next) throw new Error(`${argv[index]} requires a value\n${USAGE}`);
  return next;
}

/**
 * Whether this night deserves an attribution, and for which keys.
 *
 * Three answers, kept apart because they mean different things: a scan that broke has no
 * ledger conclusion to explain; a night with nothing new has nothing to explain; and
 * `worse`/`fixed` alone are not a reason to spend three suite runs (`fixed` means debt was
 * paid, `worse` moves inside the noise band are not debt yet).
 */
/**
 * Two outcomes, discriminated by `run`: skipped carries `reason`, runnable
 * carries `keys`. Without the literal types on `run` an inferred `boolean`
 * makes the discriminant useless — a consumer still cannot narrow, which is what
 * `plan.run === false` followed by `plan.reason` was hitting.
 *
 * @param {any} report
 * @returns {{ run: false, reason: string } | { run: true, keys: string[] }}
 */
export function attributionPlan(report) {
  if (report?.kind === "infrastructure") return skip("扫描本身没跑完，没有账本结论可以归因");
  if (!(report?.counts?.new > 0)) return skip("本轮没有新增债务，不归因");
  const keys = (report.new ?? []).map((entry) => entry.key).filter(Boolean);
  return keys.length > 0 ? { run: true, keys } : skip("报告写着 new > 0，却没列出键，不归因");
}

/** @param {string} reason @returns {{ run: false, reason: string }} */
function skip(reason) {
  return { run: false, reason };
}

/** An anchored alternation: the report must list these keys and nothing else. */
export function keyPattern(keys) {
  const escaped = keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `^(?:${escaped.join("|")})$`;
}

export function caliberOptions(plan, ub) {
  return { repeats: REPEATS, modes: [...MODES], keys: keyPattern(plan.keys), commits: [], ub };
}

/**
 * The ledger said 61.5 and three fresh runs say 33: the entry did not reproduce, and telling
 * someone to "go read that function" would send them at a number that never existed. This is
 * the same band `classifyKey` calls noise, applied across the ledger's number and today's.
 */
function outsideNoise(reported, measured) {
  if (typeof reported !== "number" || typeof measured !== "number") return false;
  const spread = Math.abs(reported - measured);
  return spread > NOISE.absolute && spread / Math.max(reported, measured, 1) > NOISE.relative;
}

/** The score the repeats settled on: the first cell, since a stable row agrees with itself. */
function settledScore(row) {
  const cells = Object.values(row.perCommit ?? {}).flatMap((modes) => Object.values(modes));
  return cells.flat().find((value) => typeof value === "number");
}

/**
 * Keep caliber's verdict unless the repeats agree on a number the ledger never saw. A
 * `run-sensitive` row is already explained and stays as it is.
 */
export function refineVerdict(row, reported) {
  if (row.verdict !== "stable") return row.verdict;
  return outsideNoise(reported, settledScore(row)) ? "not-reproduced" : row.verdict;
}

/** Measure the keys, or say why the measurement did not happen. Never throws. */
export function measureAttribution(plan, report, ub, io) {
  if (!ub) return { status: "failed", reason: "ub-mode tool chain not found; pass --ub PATH" };
  try {
    const options = caliberOptions(plan, ub);
    const measured = buildReport(measureCells(options, io), { keys: options.keys });
    const reported = new Map((report.new ?? []).map((entry) => [entry.key, entry.score]));
    const rows = measured.rows.map((row) => {
      const ledger = reported.get(row.key);
      return { ...row, ledger, verdict: refineVerdict(row, ledger) };
    });
    return {
      status: "measured",
      repeats: REPEATS,
      modes: [...MODES],
      keys: plan.keys,
      summary: countVerdicts(rows),
      rows,
    };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Nightly verdicts only: one commit, one mode, so no `code-changed`, no `source-sensitive`. */
export function countVerdicts(rows) {
  const counts = { stable: 0, "run-sensitive": 0, "not-reproduced": 0 };
  for (const row of rows) if (row.verdict in counts) counts[row.verdict] += 1;
  return counts;
}

/**
 * Three outcomes discriminated by `status`. Same reason as `attributionPlan`:
 * without literal types the discriminant widens to `string` and no consumer can
 * narrow — reading `rows` on a `skipped` result then looks legal and yields
 * `undefined`.
 *
 * @param {any} report
 * @param {string} ub
 * @param {any} io
 * @returns {
 *   | { status: "skipped", reason: string }
 *   | { status: "failed", reason: string }
 *   | { status: "measured", repeats: number, modes: string[], keys: string[], summary: Record<string, number>, rows: Array<{ key: string, ledger: unknown, verdict: string, perCommit: unknown }> }
 * }
 */
export function buildAttribution(report, ub, io) {
  const plan = attributionPlan(report);
  if (!plan.run) return { status: "skipped", reason: plan.reason };
  return measureAttribution(plan, report, ub, io);
}

const fmt = (value) => (typeof value === "number" ? value.toFixed(2) : String(value ?? "?"));

/** The three repeat scores as one cell, so a reader sees the spread without a table. */
function valueCell(row) {
  return Object.values(row.perCommit ?? {})
    .flatMap((modes) => Object.values(modes))
    .flat()
    .map(fmt)
    .join(" · ");
}

/**
 * The appendix the nightly issue carries. Empty for a skipped attribution, because a night
 * with nothing new should read exactly as it did before this step existed.
 */
export function renderAttribution(model) {
  if (!model || model.status === "skipped") return [];
  return model.status === "failed" ? renderFailed(model) : renderMeasured(model);
}

function renderFailed(model) {
  return [
    HEADING,
    "",
    `这次没能归因：\`${model.reason}\`。账本结论不受影响——归因只是解释，不是守卫。`,
    "",
  ];
}

function renderMeasured(model) {
  const rows = model.rows ?? [];
  return [HEADING, "", summaryLine(model, rows.length), "", ...renderTable(rows), "", ...VERDICT_NOTES, ""];
}

function summaryLine(model, count) {
  const summary = model.summary ?? {};
  const verdicts = Object.entries(summary).map(([verdict, value]) => `${verdict} ${value}`);
  return (
    `用账本同一条命令（${(model.modes ?? MODES).join(" / ")}）把新增的 ${count} 个键各跑了 ` +
    `${model.repeats ?? REPEATS} 次：${verdicts.join("，")}。`
  );
}

function renderTable(rows) {
  return ["| 键 | 裁决 | 账本 | 多次分数 |", "| --- | --- | --- | --- |", ...rows.map(renderRow)];
}

function renderRow(row) {
  return `| \`${row.key}\` | \`${row.verdict}\` | ${fmt(row.ledger)} | ${valueCell(row)} |`;
}

const HEADING = "### 归因（caliber）";

const VERDICT_NOTES = [
  "- `stable`：同一条命令复现出同一个分数，这是真变化（新代码，或覆盖率真的降了），去读那个函数。",
  "- `run-sensitive`：几次分数不一致，至少有一部分是测量噪声，先别把它当债去补测试。",
  "- `not-reproduced`：几次重测自己一致，但都不等于账本那个数——账本这条是采样噪声，别去补测试，也别拿它写基线。",
];

export function main(argv = process.argv.slice(2), io = defaultIO()) {
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
  if (!options.report) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const model = buildAttribution(readReport(options.report, io), options.ub, io);
  io.write(options.out, `${JSON.stringify(model, null, 2)}\n`);
  // A failed measurement leaves a non-zero exit nowhere: it is a line in the artifact and a
  // line in the issue, not a red job.
  process.stdout.write(`attribution: ${model.status}${model.reason ? ` (${model.reason})` : ""}\n`);
  return 0;
}

const invokedDirectly = isMainModule(import.meta.url, process.argv[1]);
if (invokedDirectly) {
  process.exit(main());
}
