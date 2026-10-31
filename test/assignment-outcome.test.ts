import { describe, expect, it } from "vitest";
import { assignmentOutcome } from "../src/authority/assignment-outcome.js";
import { buildRunnerRequest, retryRequest } from "../src/server/supervisor.js";
import type { RunStatus, RunState } from "../src/state/types.js";

describe("assignmentOutcome", () => {
  it("reads a finished run as completed", () => {
    for (const status of ["completed", "ready-to-merge", "publishing", "waiting-ci"] as RunStatus[]) {
      expect(assignmentOutcome(status)).toBe("completed");
    }
  });

  it("keeps a blocked run waiting on a person, and treats a broken one as failed", () => {
    expect(assignmentOutcome("blocked")).toBe("blocked");
    expect(assignmentOutcome("ci-failed")).toBe("failed");
    expect(assignmentOutcome("repairing")).toBe("failed");
    expect(assignmentOutcome("implementing")).toBe("failed");
  });

  it("reads a cancelled or interrupted run as interrupted", () => {
    expect(assignmentOutcome("cancelled")).toBe("interrupted");
    expect(assignmentOutcome("interrupted")).toBe("interrupted");
    expect(assignmentOutcome(undefined)).toBe("interrupted");
  });
});

describe("ticketId plumbing", () => {
  const state = {
    id: "run-1",
    goal: "do the thing",
    profileOverrides: {},
    strategy: { name: "balanced" },
    ticketId: "tk-9",
  } as unknown as RunState;

  it("a retry stays an Assignment of the same Ticket", () => {
    expect(retryRequest(state, undefined)).toMatchObject({ ticketId: "tk-9", parentRunId: "run-1" });
  });

  it("a run without a Ticket does not grow one", () => {
    const bare = { ...state, ticketId: undefined } as unknown as RunState;
    expect(retryRequest(bare, undefined)).not.toHaveProperty("ticketId");
  });

  it("the runner request stays free of the Ticket: it is the supervisor's record", () => {
    const request = buildRunnerRequest({
      request: { goal: "g", profileOverrides: {}, ticketId: "tk-9" },
      runId: "run-1",
      prepared: { profileOverrides: {} } as never,
      signal: new AbortController().signal,
      supervisorId: "sup",
    });
    expect(request).not.toHaveProperty("ticketId");
  });
});
