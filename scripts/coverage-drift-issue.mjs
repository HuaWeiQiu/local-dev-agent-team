#!/usr/bin/env node
/**
 * Turn a coverage-drift report into one issue.
 *
 * The workflow stays dumb on purpose: the decision (what the issue says, whether
 * there is anything to say, whether yesterday's issue should close) lives here as
 * a pure function, so it can be tested without GitHub.
 *
 * Two kinds are never merged into one number:
 *   infrastructure  the scan itself broke (missing tool chain, crashed run, no
 *                   coverage). This is the #143 class: a broken run must never be
 *                   reported as a clean ledger.
 *   ledger           debt appeared or grew, with the entries listed.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/**
 * The baseline is measured on the developer machines, the nightly job runs on
 * Linux, and the two disagree on functions that sit near the threshold. Until that
 * is unified, a ledger count is a lead, not a verdict — and the title has to say so
 * or a noisy issue just trains people to scroll past it.
 */
export const CALIBER_UNIFIED = false;

const LEDGER_TITLE = "Coverage drift · 账本上涨";

export const ISSUE_TITLE = {
  infrastructure: "Coverage drift · 基础设施失败",
  ledger: CALIBER_UNIFIED ? LEDGER_TITLE : `【待分诊】${LEDGER_TITLE}`,
};

const CALIBER_NOTE = CALIBER_UNIFIED
  ? ""
  : "> 跨环境口径尚未统一（macOS 基线 vs Linux nightly）：数字仅供参考，先分诊再处理。\n\n";

const SEARCH = "Coverage drift in:title";

/**
 * A report that cannot be read is an infrastructure verdict, not a clean ledger:
 * the gate writes this file on every path it controls, so a missing or broken file
 * means something outside the gate broke.
 */
export function infrastructureReport(error) {
  return {
    kind: "infrastructure",
    generatedAt: new Date().toISOString(),
    threshold: 10,
    baseline: ".ub-crap-baseline.json",
    error,
    counts: { new: 0, worse: 0, fixed: 0 },
    new: [],
    worse: [],
    fixed: [],
  };
}

export function reportFromText(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") return parsed;
    return infrastructureReport("drift report is not a verdict object");
  } catch {
    return infrastructureReport("drift report is not valid JSON");
  }
}

export function readReport(file) {
  if (!existsSync(file)) return infrastructureReport(`drift report missing at ${file}`);
  return reportFromText(readFileSync(file, "utf8"));
}

/** What to do with the report: a title, a body, and whether to close instead. */
export function issuePlan(report, options = {}) {
  const kind = report?.kind === "infrastructure" ? "infrastructure" : "ledger";
  const counts = report?.counts ?? { new: 0, worse: 0, fixed: 0 };
  const raised = counts.new + counts.worse;
  return {
    kind,
    title: ISSUE_TITLE[kind],
    shouldClose: kind === "ledger" && raised === 0,
    body: renderBody(report ?? {}, { kind, counts, raised, ...options }),
  };
}

function renderBody(report, { kind, counts, raised, runUrl, generatedAt }) {
  return [
    ...(CALIBER_NOTE ? [CALIBER_NOTE.trim(), ""] : []),
    ...renderHeader(report, counts, generatedAt, kind),
    ...renderVerdict(report, kind, raised),
    ...section("已还清", report.fixed ?? [], (entry) => `${entry.key}（基线 ${fmt(entry.frozen)}）`),
    ...(runUrl ? ["", `运行记录：${runUrl}`] : []),
    "",
  ].join("\n") + "\n";
}

/** What the report is about: when it ran, against which baseline, and the counts. */
function renderHeader(report, counts, generatedAt, kind) {
  return [
    `- 生成时间：${report.generatedAt ?? generatedAt ?? "unknown"}`,
    `- 类型：**${kind === "infrastructure" ? "基础设施失败" : "账本上涨"}**`,
    `- 阈值：CRAP > ${report.threshold ?? 10}`,
    `- 基线：\`${report.baseline ?? ".ub-crap-baseline.json"}\``,
    "",
    "| new | worse | fixed |",
    "| --- | --- | --- |",
    `| ${counts.new} | ${counts.worse} | ${counts.fixed} |`,
    "",
  ];
}

/** The one thing a reader must act on: broken scan, clean ledger, or new debt. */
function renderVerdict(report, kind, raised) {
  if (kind === "infrastructure") return renderInfrastructure(report);
  if (raised === 0) return ["账本没有上涨。`fixed` 是这一轮还清的债，供参考。", ""];
  return [
    ...section("新增债务", report.new ?? [], (entry) => `${entry.key} — ${fmt(entry.score)}`),
    ...section(
      "恶化",
      report.worse ?? [],
      (entry) => `${entry.key} — ${fmt(entry.score)}（基线 ${fmt(entry.frozen)}）`,
    ),
  ];
}

function renderInfrastructure(report) {
  return [
    "扫描本身没跑完，**这不是账本结论**。先修基础设施再谈分数：",
    "",
    "```text",
    String(report.error ?? "unknown error"),
    "```",
    "",
  ];
}

function section(heading, entries, line) {
  if (entries.length === 0) return [];
  const shown = entries.slice(0, 20).map((entry) => `- ${line(entry)}`);
  const more = entries.length > shown.length ? [`- … 其余 ${entries.length - shown.length} 条见运行记录`] : [];
  return [`### ${heading}（${entries.length}）`, "", ...shown, ...more, ""];
}

function fmt(value) {
  return typeof value === "number" ? value.toFixed(1) : String(value ?? "?");
}

/** Apply the plan through `gh`. Only this part needs a token and a repository. */
export function applyPlan(plan, options = {}) {
  const gh = options.gh ?? defaultGh;
  const issues = listOpenIssues(gh);
  if (plan.shouldClose) return closeLedgerIssues(gh, issues);
  // A completed scan is the evidence that closes an older infrastructure verdict:
  // not "a newer issue exists", but "the thing that was broken now produced a
  // verdict". An infrastructure failure proves nothing about the ledger, so it
  // never closes a ledger issue.
  const superseded = plan.kind === "ledger" ? issues.filter((issue) => issue.title !== plan.title) : [];
  for (const issue of superseded) closeIssue(gh, issue.number, `由「${plan.title}」接替：本轮扫描已完成，上一轮结论不再成立。`);
  const same = issues.find((issue) => issue.title === plan.title);
  if (same) return updateIssue(gh, same.number, plan);
  return openIssue(gh, plan);
}

function defaultGh(args) {
  return spawnSync("gh", args, { encoding: "utf8" });
}

function listOpenIssues(gh) {
  const result = gh(["issue", "list", "--state", "open", "--search", SEARCH, "--json", "number,title", "--limit", "20"]);
  if (result.status !== 0) throw new Error(`gh issue list failed: ${result.stderr}`);
  return JSON.parse(result.stdout || "[]");
}

function closeIssue(gh, number, comment) {
  gh(["issue", "close", String(number), "--comment", comment]);
}

function closeLedgerIssues(gh, issues) {
  for (const issue of issues) closeIssue(gh, issue.number, "账本已归零，自动关闭。");
  return { action: issues.length > 0 ? "closed" : "noop", issues: issues.map((issue) => issue.number) };
}

function updateIssue(gh, number, plan) {
  const result = gh(["issue", "edit", String(number), "--body", plan.body]);
  if (result.status !== 0) throw new Error(`gh issue edit failed: ${result.stderr}`);
  return { action: "updated", issues: [number] };
}

function openIssue(gh, plan) {
  const result = gh(["issue", "create", "--title", plan.title, "--body", plan.body]);
  if (result.status !== 0) throw new Error(`gh issue create failed: ${result.stderr}`);
  return { action: "created", issues: [], url: result.stdout.trim() };
}

function main(argv) {
  const [file] = argv;
  if (!file) {
    process.stderr.write("usage: node scripts/coverage-drift-issue.mjs <drift-report.json>\n");
    return 1;
  }
  const report = readReport(file);
  const plan = issuePlan(report, { runUrl: process.env.RUN_URL });
  const applied = applyPlan(plan);
  process.stdout.write(`issue: ${applied.action} ${JSON.stringify(applied)}\n`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith("coverage-drift-issue.mjs");
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
