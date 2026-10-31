import { describe, expect, it } from "vitest";
import type { ReviewVerdict, TestVerdict } from "../src/domain/contracts.js";
import type { QualityReport } from "../src/quality/run.js";
import {
  computeFailureSignature,
  isRepeatedFailure,
  normalizeFailureText,
} from "../src/workflow/failure-signature.js";

function failing(stderr: string, exitCode: number | null = 1, timedOut = false): QualityReport {
  return {
    passed: false,
    commands: [
      {
        spec: { command: "pnpm", args: ["test"] },
        exitCode,
        stdout: "",
        stderr,
        durationMs: 10,
        timedOut,
      },
    ],
  };
}

const requestChanges = (message: string, path = "src/a.ts"): ReviewVerdict => ({
  verdict: "request_changes",
  summary: "needs work",
  findings: [{ severity: "high", path, line: 3, message, required: true }],
});

const approveTest: TestVerdict = { verdict: "approve", summary: "ok", missingTests: [] };

describe("normalizeFailureText", () => {
  it("removes volatile details", () => {
    const first = normalizeFailureText(
      "\u001b[31mFAIL\u001b[0m src/a.ts:12:34 at 2026-10-03T10:00:01.123Z in /tmp/abc123/x took 120ms",
    );
    const second = normalizeFailureText(
      "FAIL src/a.ts:99:1 at 2026-10-04T11:22:33Z in /var/folders/zz/y/T/q took 7ms",
    );
    expect(first).toBe(second);
  });
});

describe("computeFailureSignature", () => {
  it("is stable across line numbers, timestamps and temp paths", () => {
    const left = computeFailureSignature({
      quality: failing("AssertionError at src/a.ts:10:5 (/tmp/run1/a) 2026-10-03T10:00:00Z"),
      review: requestChanges("Missing null check on line 10"),
      test: approveTest,
    });
    const right = computeFailureSignature({
      quality: failing("AssertionError at src/a.ts:42:9 (/tmp/run2/b) 2026-10-03T11:30:00Z"),
      review: requestChanges("Missing null check on line 42"),
      test: approveTest,
    });
    expect(left.signature).toBe(right.signature);
    expect(isRepeatedFailure(left, right)).toBe(true);
  });

  it("differs when a different command fails or the error changes", () => {
    const base = computeFailureSignature({ quality: failing("TypeError: x is undefined") });
    const other = computeFailureSignature({ quality: failing("SyntaxError: unexpected token") });
    expect(base.signature).not.toBe(other.signature);
    expect(isRepeatedFailure(base, other)).toBe(false);
  });

  it("distinguishes timeouts from exit codes", () => {
    const exit = computeFailureSignature({ quality: failing("slow", 1) });
    const timeout = computeFailureSignature({ quality: failing("slow", null, true) });
    expect(exit.signature).not.toBe(timeout.signature);
  });

  it("ignores passing commands and non-required findings", () => {
    const quality: QualityReport = {
      passed: true,
      commands: [
        {
          spec: { command: "pnpm", args: ["check"] },
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          durationMs: 1,
          timedOut: false,
        },
      ],
    };
    const review: ReviewVerdict = {
      verdict: "approve",
      summary: "fine",
      findings: [{ severity: "low", path: "a", line: null, message: "nit", required: false }],
    };
    const empty = computeFailureSignature({});
    expect(computeFailureSignature({ quality, review, test: approveTest }).signature).toBe(
      empty.signature,
    );
  });

  it("falls back to the error message when no gate produced facts", () => {
    const left = computeFailureSignature({ errorMessage: "No repository changes were produced." });
    const right = computeFailureSignature({ errorMessage: "No repository changes were produced." });
    const other = computeFailureSignature({ errorMessage: "Owned path violation: src/x.ts" });
    expect(left.signature).toBe(right.signature);
    expect(left.signature).not.toBe(other.signature);
  });

  it("treats the first failure as not repeated", () => {
    expect(isRepeatedFailure(undefined, computeFailureSignature({ errorMessage: "boom" }))).toBe(
      false,
    );
  });
});
