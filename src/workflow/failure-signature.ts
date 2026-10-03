import { createHash } from "node:crypto";
import type { ReviewVerdict, TestVerdict } from "../domain/contracts.js";
import type { QualityReport } from "../quality/run.js";

export interface FailureSignatureInput {
  quality?: QualityReport;
  review?: ReviewVerdict;
  test?: TestVerdict;
  /** Raw failure text for attempts that failed before any gate produced output. */
  errorMessage?: string;
}

export interface FailureSignature {
  signature: string;
  /** Short human-readable description of the normalized failure facts. */
  summary: string;
}

const OUTPUT_TAIL_CHARS = 1_500;
const SUMMARY_MAX_CHARS = 400;

const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?/g;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const HEX_ADDRESS_PATTERN = /\b0x[0-9a-f]+\b/g;
const TEMP_PATH_PATTERN =
  /(?:\/private)?\/(?:var\/folders|tmp)\/[^\s"'`)]*|[a-z]:\\users\\[^\s"'`)]*\\temp\\[^\s"'`)]*/g;
const WORKTREE_PATH_PATTERN = /[^\s"'`(]*\.agent-team\/[^\s"'`)]*/g;
const DIGITS_PATTERN = /\d+/g;
const WHITESPACE_PATTERN = /\s+/g;

/**
 * Strip volatile details (timestamps, ids, temp/worktree paths, line numbers,
 * durations) so two failures with the same cause normalize to the same text.
 */
export function normalizeFailureText(text: string): string {
  return text
    .replace(ANSI_PATTERN, "")
    .toLowerCase()
    .replace(ISO_TIMESTAMP_PATTERN, "<time>")
    .replace(UUID_PATTERN, "<id>")
    .replace(HEX_ADDRESS_PATTERN, "<addr>")
    .replace(TEMP_PATH_PATTERN, "<tmp>")
    .replace(WORKTREE_PATH_PATTERN, "<worktree>")
    .replace(DIGITS_PATTERN, "#")
    .replace(WHITESPACE_PATTERN, " ")
    .trim();
}

/**
 * Deterministic fingerprint of why an attempt failed. It is the "fork layer"
 * decision input: identical fingerprints on consecutive attempts mean a blind
 * retry is unlikely to help and the approach should be reconsidered.
 */
export function computeFailureSignature(input: FailureSignatureInput): FailureSignature {
  const facts: string[] = [];

  for (const command of input.quality?.commands ?? []) {
    if (command.exitCode === 0 && !command.timedOut) {
      continue;
    }
    const name = [command.spec.command, ...command.spec.args].join(" ");
    const output = normalizeFailureText(
      `${command.stderr.slice(-OUTPUT_TAIL_CHARS)}\n${command.stdout.slice(-OUTPUT_TAIL_CHARS)}`,
    );
    const status = command.timedOut ? "timeout" : `exit:${command.exitCode ?? "null"}`;
    facts.push(`cmd|${name}|${status}|${output}`);
  }

  for (const finding of input.review?.findings ?? []) {
    if (finding.required) {
      facts.push(`review|${finding.path}|${normalizeFailureText(finding.message)}`);
    }
  }
  if (input.review && input.review.verdict !== "approve" && input.review.findings.length === 0) {
    facts.push(`review|${input.review.verdict}|${normalizeFailureText(input.review.summary)}`);
  }

  for (const missing of input.test?.missingTests ?? []) {
    facts.push(`test|${normalizeFailureText(missing)}`);
  }
  if (input.test && input.test.verdict !== "approve" && input.test.missingTests.length === 0) {
    facts.push(`test|${input.test.verdict}|${normalizeFailureText(input.test.summary)}`);
  }

  if (facts.length === 0 && input.errorMessage) {
    facts.push(`error|${normalizeFailureText(input.errorMessage)}`);
  }

  const canonical = [...new Set(facts)].sort();
  const signature = createHash("sha256").update(canonical.join("\n")).digest("hex").slice(0, 16);
  const summary = (canonical.length === 0 ? "no failure facts" : canonical.join(" ; ")).slice(
    0,
    SUMMARY_MAX_CHARS,
  );
  return { signature, summary };
}

/** True when two consecutive attempts failed for the same normalized reason. */
export function isRepeatedFailure(
  previous: FailureSignature | undefined,
  current: FailureSignature,
): boolean {
  return previous !== undefined && previous.signature === current.signature;
}
