import { describe, expect, it } from "vitest";
import {
  isHardSpecialistEscalation,
  isPlaceholderVerdict,
  shouldAcceptDocsDespiteEscalate,
  shouldTrustQualityOverReview,
} from "../src/workflow/runner.js";
import { terminalStatusAfterFailure } from "../src/workflow/runner.js";

describe("terminalStatusAfterFailure", () => {
  it("maps explicit user cancel to cancelled", () => {
    const controller = new AbortController();
    controller.abort(new Error("Run cancelled by user"));
    expect(terminalStatusAfterFailure(controller.signal.reason, controller.signal)).toBe(
      "cancelled",
    );
  });

  it("maps control-service shutdown to interrupted for checkpoint resume", () => {
    const controller = new AbortController();
    controller.abort(new Error("Control service is shutting down"));
    expect(terminalStatusAfterFailure(controller.signal.reason, controller.signal)).toBe(
      "interrupted",
    );
  });

  it("maps non-abort failures to blocked", () => {
    expect(terminalStatusAfterFailure(new Error("quality failed"))).toBe("blocked");
  });
});

describe("placeholder specialist verdicts", () => {
  it("treats inspecting-before-issuing summaries as placeholders", () => {
    expect(
      isPlaceholderVerdict(
        "escalate",
        "Inspecting the T3 CHANGELOG contract, owned-path diff, and repository evidence before issuing a verdict.",
      ),
    ).toBe(true);
  });

  it("treats in-progress review text as a placeholder, not a hard escalate", () => {
    expect(
      isPlaceholderVerdict(
        "escalate",
        "Reading the full tester prompt, task contract, and offloaded diff before judging acceptance coverage.",
      ),
    ).toBe(true);
    expect(
      isHardSpecialistEscalation(
        {
          verdict: "request_changes",
          summary: "Reading the full review prompt and independently inspecting the T1 diff.",
          findings: [],
        },
        {
          verdict: "escalate",
          summary: "Reading the full tester prompt before judging acceptance coverage.",
          missingTests: [],
        },
      ),
    ).toBe(false);
  });

  it("treats Chinese in-progress review text as a placeholder", () => {
    expect(isPlaceholderVerdict("escalate", "正在检查合同再给结论")).toBe(true);
    expect(isPlaceholderVerdict("request_changes", "正在阅读完整审查提示词")).toBe(true);
  });

  it("treats need-full-prompt escalates with empty findings as placeholders", () => {
    // Real-world phrasing from a grok reviewer that returned a final escalate
    // while still declaring intent to inspect, with zero findings.
    const summary =
      "Need the full prompt and independent inspection of the staged diff before any approve/request_changes verdict.";
    expect(isPlaceholderVerdict("escalate", summary)).toBe(true);
    expect(
      isHardSpecialistEscalation(
        { verdict: "escalate", summary, findings: [] },
        { verdict: "approve", summary: "Covered", missingTests: [] },
      ),
    ).toBe(false);
    expect(
      shouldTrustQualityOverReview(
        { verdict: "escalate", summary, findings: [] },
        { verdict: "approve", summary: "Covered", missingTests: [] },
      ),
    ).toBe(true);
  });

  it("lets a docs task pass when quality already passed and specialists escalate", () => {
    expect(
      shouldAcceptDocsDespiteEscalate(
        {
          id: "T3",
          title: "Write CHANGELOG.md",
          description: "Add a changelog entry",
          dependsOn: [],
          ownedPaths: ["CHANGELOG.md"],
          acceptanceCommands: [],
          profile: null,
        },
        { verdict: "escalate", summary: "Need host evidence", findings: [] },
        { verdict: "escalate", summary: "Need more tests", missingTests: ["host"] },
      ),
    ).toBe(true);
    expect(
      shouldAcceptDocsDespiteEscalate(
        {
          id: "T1",
          title: "Add greet.js",
          description: "Implement greet",
          dependsOn: [],
          ownedPaths: ["src/greet.js"],
          acceptanceCommands: [],
          profile: null,
        },
        { verdict: "escalate", summary: "Need host evidence", findings: [] },
        { verdict: "escalate", summary: "Need more tests", missingTests: ["host"] },
      ),
    ).toBe(false);
    expect(
      shouldTrustQualityOverReview(
        { verdict: "escalate", summary: "正在检查合同再给结论", findings: [] },
        { verdict: "approve", summary: "Covered", missingTests: [] },
      ),
    ).toBe(true);
  });

  it("keeps a real escalate as a hard stop", () => {
    expect(
      isHardSpecialistEscalation(
        { verdict: "approve", summary: "Looks good", findings: [] },
        { verdict: "escalate", summary: "Host evidence is required and missing", missingTests: [] },
      ),
    ).toBe(true);
  });
});
