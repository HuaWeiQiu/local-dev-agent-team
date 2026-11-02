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

export const ISSUE_TITLE = {
  infrastructure: "Coverage drift · 基础设施失败",
  ledger: "Coverage drift · 账本上涨",
};

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
  const lines = [
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
  if (kind === "infrastructure") {
    lines.push(
      "扫描本身没跑完，**这不是账本结论**。先修基础设施再谈分数：",
      "",
      "```text",
      String(report.error ?? "unknown error"),
      "```",
      "",
    );
  } else if (raised === 0) {
    lines.push("账本没有上涨。`fixed` 是这一轮还清的债，供参考。", "");
  } else {
    lines.push(...section("新增债务", report.new ?? [], (entry) => `${entry.key} — ${fmt(entry.score)}`));
    lines.push(
      ...section(
        "恶化",
        report.worse ?? [],
        (entry) => `${entry.key} — ${fmt(entry.score)}（基线 ${fmt(entry.frozen)}）`,
      ),
    );
  }
  lines.push(...section("已还清", report.fixed ?? [], (entry) => `${entry.key}（基线 ${fmt(entry.frozen)}）`));
  if (runUrl) lines.push("", `运行记录：${runUrl}`);
  return `${lines.join("\n")}\n`;
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
  const gh = options.gh ?? ((args) => spawnSync("gh", args, { encoding: "utf8" }));
  const open = gh(["issue", "list", "--state", "open", "--search", SEARCH, "--json", "number,title", "--limit", "20"]);
  if (open.status !== 0) throw new Error(`gh issue list failed: ${open.stderr}`);
  const issues = JSON.parse(open.stdout || "[]");
  if (plan.shouldClose) {
    for (const issue of issues) gh(["issue", "close", String(issue.number), "--comment", "账本已归零，自动关闭。"]);
    return { action: issues.length > 0 ? "closed" : "noop", issues: issues.map((issue) => issue.number) };
  }
  const same = issues.find((issue) => issue.title === plan.title);
  const stale = issues.filter((issue) => issue.title !== plan.title);
  for (const issue of stale) {
    gh(["issue", "close", String(issue.number), "--comment", `由「${plan.title}」接替。`]);
  }
  if (same) {
    const edited = gh(["issue", "edit", String(same.number), "--body", plan.body]);
    if (edited.status !== 0) throw new Error(`gh issue edit failed: ${edited.stderr}`);
    return { action: "updated", issues: [same.number] };
  }
  const created = gh(["issue", "create", "--title", plan.title, "--body", plan.body]);
  if (created.status !== 0) throw new Error(`gh issue create failed: ${created.stderr}`);
  return { action: "created", issues: [], url: created.stdout.trim() };
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
