import type { ReviewVerdict, Task, TestVerdict } from "../domain/contracts.js";
import { classifyTaskKind } from "../domain/plan.js";
import type { QualityReport } from "../quality/run.js";

export function isPlaceholderVerdict(verdict: string, summary: string): boolean {
  const text = `${verdict} ${summary}`.toLowerCase();
  return (
    /review in progress|placeholder will be replaced|still reading|before issuing|before judging|before any .+ verdict|need the full prompt|independent inspection|reading the full (review|tester) prompt|independently inspecting|inspecting .+ before issuing|正在检查|再给结论|正在阅读|正在读|先读完|尚未给出/.test(
      text,
    )
  );
}

export function shouldAcceptDocsDespiteEscalate(
  task: Task,
  review: ReviewVerdict,
  test: TestVerdict,
): boolean {
  const kind = classifyTaskKind(task);
  if (kind !== "docs" && kind !== "host-evidence") {
    return false;
  }
  return isHardSpecialistEscalation(review, test) || shouldTrustQualityOverReview(review, test);
}

export function isHardSpecialistEscalation(review: ReviewVerdict, test: TestVerdict): boolean {
  const reviewEscalated = review.verdict === "escalate" && !isPlaceholderVerdict(review.verdict, review.summary);
  const testEscalated = test.verdict === "escalate" && !isPlaceholderVerdict(test.verdict, test.summary);
  return reviewEscalated || testEscalated;
}

export function shouldTrustQualityOverReview(review: ReviewVerdict, test: TestVerdict): boolean {
  const reviewOk =
    review.verdict === "approve"
    || isPlaceholderVerdict(review.verdict, review.summary);
  const testOk =
    test.verdict === "approve"
    || isPlaceholderVerdict(test.verdict, test.summary);
  return reviewOk && testOk;
}

export function passesTaskGates(
  quality: QualityReport,
  review: ReviewVerdict,
  test: TestVerdict,
): boolean {
  return (
    quality.passed &&
    review.verdict === "approve" &&
    !review.findings.some((finding) => finding.required) &&
    test.verdict === "approve"
  );
}

export function buildReworkFeedback(
  quality: QualityReport,
  review: ReviewVerdict,
  test: TestVerdict,
): string {
  return JSON.stringify(
    {
      deterministicChecks: compactQuality(quality),
      review,
      test,
    },
    null,
    2,
  );
}

export function buildQualityFeedback(quality: QualityReport): string {
  return JSON.stringify({ deterministicChecks: compactQuality(quality) }, null, 2);
}

export function compactQuality(report: QualityReport): unknown {
  return {
    passed: report.passed,
    commands: report.commands.map((command) => ({
      command: command.spec,
      exitCode: command.exitCode,
      timedOut: command.timedOut,
      stdout: command.stdout.slice(-20_000),
      stderr: command.stderr.slice(-20_000),
    })),
  };
}
