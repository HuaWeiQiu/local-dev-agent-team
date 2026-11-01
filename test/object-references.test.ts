import { describe, expect, it } from "vitest";
import {
  REFERENCE_SUMMARY_LIMIT,
  attemptReferences,
  renderReference,
  renderReferences,
  shortSummary,
  uniqueRefs,
  type ObjectRef,
} from "../src/runtime/references.js";

describe("renderReference", () => {
  it("names the object, and says why when there is a reason", () => {
    expect(renderReference({ kind: "run", id: "run-1" })).toBe("- run/run-1");
    expect(renderReference({ kind: "ticket", id: "ticket-1", summary: "waiting on a review" })).toBe(
      "- ticket/ticket-1: waiting on a review",
    );
  });

  it("keeps a summary on one line", () => {
    const ref: ObjectRef = { kind: "task", id: "T1", summary: "first line\nsecond   line" };
    expect(renderReference(ref)).toBe("- task/T1: first line second line");
  });

  it("treats an empty summary as no summary", () => {
    expect(renderReference({ kind: "run", id: "run-1", summary: "   " })).toBe("- run/run-1");
  });
});

describe("shortSummary", () => {
  it("passes a short summary through", () => {
    expect(shortSummary("done")).toBe("done");
  });

  it("bounds a long one rather than pasting it", () => {
    const long = "x".repeat(500);
    const summary = shortSummary(long);
    expect(summary).toHaveLength(REFERENCE_SUMMARY_LIMIT);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("says nothing for nothing", () => {
    expect(shortSummary(undefined)).toBe("");
    expect(shortSummary("")).toBe("");
  });
});

describe("renderReferences", () => {
  it("renders one line per reference, in the order given", () => {
    const text = renderReferences([
      { kind: "run", id: "run-1", summary: "ship it" },
      { kind: "task", id: "T1" },
    ]);
    expect(text.split("\n")).toEqual(["- run/run-1: ship it", "- task/T1"]);
  });

  it("stays empty rather than becoming an empty heading", () => {
    expect(renderReferences([])).toBe("");
  });
});

describe("uniqueRefs", () => {
  it("drops a repeated object but keeps the first place it appeared", () => {
    const refs = uniqueRefs([
      { kind: "run", id: "run-1" },
      { kind: "task", id: "T1" },
      { kind: "run", id: "run-1", summary: "again" },
    ]);
    expect(refs.map((ref) => `${ref.kind}/${ref.id}`)).toEqual(["run/run-1", "task/T1"]);
  });

  it("treats the same id under different kinds as different objects", () => {
    expect(uniqueRefs([{ kind: "run", id: "x" }, { kind: "task", id: "x" }])).toHaveLength(2);
  });
});

describe("attemptReferences", () => {
  it("names the run, the ticket and the task", () => {
    const refs = attemptReferences({
      runId: "run-1",
      goal: "ship the thing",
      ticketId: "ticket-run-1",
      task: { id: "T1", title: "write the code" },
    });
    expect(refs).toEqual([
      { kind: "run", id: "run-1", summary: "ship the thing" },
      { kind: "ticket", id: "ticket-run-1", summary: "this run's authorized work" },
      { kind: "task", id: "T1", summary: "write the code" },
    ]);
  });

  it("leaves the ticket out when the run has none", () => {
    const refs = attemptReferences({
      runId: "run-1",
      goal: "ship the thing",
      task: { id: "T1", title: "write the code" },
    });
    expect(refs.map((ref) => ref.kind)).toEqual(["run", "task"]);
  });

  it("renders as a list the prompt can carry", () => {
    const text = renderReferences(
      attemptReferences({ runId: "run-1", goal: "g", task: { id: "T1", title: "t" } }),
    );
    expect(text).toContain("- run/run-1: g");
    expect(text).toContain("- task/T1: t");
  });
});
