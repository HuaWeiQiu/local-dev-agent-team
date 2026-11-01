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

// eslint-disable-next-line no-control-regex -- matching the ESC byte is the point
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
  const facts = failureFacts(input);
  const canonical = [...new Set(facts)].sort();
  return {
    signature: createHash("sha256").update(canonical.join("\n")).digest("hex").slice(0, 16),
    summary: (canonical.length === 0 ? "no failure facts" : canonical.join(" ; ")).slice(
      0,
      SUMMARY_MAX_CHARS,
    ),
  };
}

/**
 * Everything the failure actually said, one fact per line.
 *
 * Order matters only for reading; the signature sorts and de-duplicates these, so
 * the same failure cannot produce two signatures because it was reported twice.
 */
export function failureFacts(input: FailureSignatureInput): string[] {
  const facts = [
    ...commandFacts(input.quality),
    ...reviewFacts(input.review),
    ...testFacts(input.test),
  ];
  // The bare error message is a last resort: a real command, review or test result
  // says more than the message that wrapped it.
  if (facts.length === 0 && input.errorMessage) {
    facts.push(`error|${normalizeFailureText(input.errorMessage)}`);
  }
  return facts;
}

/** One fact per failed command, carrying its exit status and the tail of output. */
function commandFacts(quality: FailureSignatureInput["quality"]): string[] {
  const facts: string[] = [];
  for (const command of quality?.commands ?? []) {
    if (command.exitCode === 0 && !command.timedOut) continue;
    const name = [command.spec.command, ...command.spec.args].join(" ");
    const output = normalizeFailureText(
      `${command.stderr.slice(-OUTPUT_TAIL_CHARS)}\n${command.stdout.slice(-OUTPUT_TAIL_CHARS)}`,
    );
    facts.push(`cmd|${name}|${commandStatus(command)}|${output}`);
  }
  return facts;
}

function commandStatus(command: { exitCode: number | null; timedOut: boolean }): string {
  return command.timedOut ? "timeout" : `exit:${command.exitCode ?? "null"}`;
}

/** A required finding is a fact; a verdict with no findings is a fact of its own. */
function reviewFacts(review: FailureSignatureInput["review"]): string[] {
  const facts = (review?.findings ?? [])
    .filter((finding) => finding.required)
    .map((finding) => `review|${finding.path}|${normalizeFailureText(finding.message)}`);
  if (review && review.verdict !== "approve" && review.findings.length === 0) {
    facts.push(`review|${review.verdict}|${normalizeFailureText(review.summary)}`);
  }
  return facts;
}

/** The same rule as reviews, for what the tester says is missing. */
function testFacts(test: FailureSignatureInput["test"]): string[] {
  const facts = (test?.missingTests ?? []).map((missing) => `test|${normalizeFailureText(missing)}`);
  if (test && test.verdict !== "approve" && test.missingTests.length === 0) {
    facts.push(`test|${test.verdict}|${normalizeFailureText(test.summary)}`);
  }
  return facts;
}


/** True when two consecutive attempts failed for the same normalized reason. */
export function isRepeatedFailure(
  previous: FailureSignature | undefined,
  current: FailureSignature,
): boolean {
  return previous !== undefined && previous.signature === current.signature;
}
