#!/usr/bin/env node
/**
 * Reading a drift report, tolerantly.
 *
 * Two readers need the same rule: the nightly issue writer, and the attribution step that
 * runs after a scan. The rule is small but it must not exist twice — if one reader treated
 * a broken file as "a clean ledger" and the other treated it as "a broken scan", the two
 * would describe the same night differently.
 *
 * The rule: a report that cannot be read is an `infrastructure` verdict, never a clean
 * ledger. The gate writes this file on every path it controls, so a missing or broken file
 * means something outside the gate broke.
 */

import { existsSync, readFileSync } from "node:fs";

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

const realFS = { exists: existsSync, read: (file) => readFileSync(file, "utf8") };

/**
 * The file's verdict, through whichever filesystem the caller works with. The IO seam is a
 * parameter rather than an import so the night's whole flow can be driven from memory —
 * the same seam `coverage-caliber-report.mjs` measures through.
 */
export function readReport(file, io = realFS) {
  if (!file || !io.exists(file)) return infrastructureReport(`drift report missing at ${file}`);
  return reportFromText(io.read(file));
}
