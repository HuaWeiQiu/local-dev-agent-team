import { describe, expect, it } from "vitest";
import {
  TicketError,
  acceptTrigger,
  assignmentHistory,
  endAssignment,
  endTicket,
  hasMultipleAssignments,
  openTicket,
  resumeTicket,
  runningAssignment,
  startAssignment,
  ticketStage,
  type Ticket,
} from "../src/authority/ticket.js";
import type { Mandate, PolicySnapshot } from "../src/authority/types.js";

const mandate = (patch: Partial<Mandate> = {}): Mandate => ({
  id: "m1",
  triggerId: "t1",
  policyVersion: "v1",
  scope: ["src/a"],
  strength: "explicit",
  actor: { sourceKind: "github", id: "alice" },
  sourceKind: "github",
  reliedOn: ["gate:plan"],
  grantedAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});

const policy = (patch: Partial<PolicySnapshot> = {}): PolicySnapshot => ({
  version: "v1",
  allowedActors: ["alice"],
  allowsProactive: false,
  rules: ["gate:plan"],
  ...patch,
});

const ticket = (): Ticket =>
  openTicket({ id: "tk1", threadKey: "thread-1", mandate: mandate(), triggerId: "t1" });

describe("opening a ticket", () => {
  it("starts open, with the Trigger that opened it and no Assignment", () => {
    const opened = ticket();
    expect(opened).toMatchObject({ state: "open", triggerIds: ["t1"], assignments: [] });
    expect(opened.ended).toBeUndefined();
  });
});

describe("assignments", () => {
  it("allows one running Assignment at a time", () => {
    const running = startAssignment(ticket(), { id: "a1", runId: "r1", at: "2026-01-01T01:00:00Z" });
    expect(runningAssignment(running)?.runId).toBe("r1");
    expect(() =>
      startAssignment(running, { id: "a2", runId: "r2", at: "2026-01-01T02:00:00Z" }),
    ).toThrow(TicketError);
  });

  it("ends an Assignment without ending the Ticket", () => {
    const running = startAssignment(ticket(), { id: "a1", runId: "r1", at: "t1" });
    const ended = endAssignment(running, { id: "a1", at: "t2", outcome: "failed" });
    expect(ended.state).toBe("open");
    expect(ended.assignments[0]).toMatchObject({ state: "ended", outcome: "failed" });
    expect(runningAssignment(ended)).toBeUndefined();
  });

  it("ignores a second end of the same Assignment", () => {
    const running = startAssignment(ticket(), { id: "a1", runId: "r1", at: "t1" });
    const once = endAssignment(running, { id: "a1", at: "t2", outcome: "completed" });
    expect(endAssignment(once, { id: "a1", at: "t3", outcome: "failed" })).toBe(once);
  });

  it("refuses to end an Assignment it does not have", () => {
    expect(() => endAssignment(ticket(), { id: "nope", at: "t", outcome: "completed" })).toThrow(
      /no Assignment/,
    );
  });

  it("lets a Ticket be worked on twice, and keeps both", () => {
    const first = endAssignment(
      startAssignment(ticket(), { id: "a1", runId: "r1", at: "t1" }),
      { id: "a1", at: "t2", outcome: "failed" },
    );
    const second = startAssignment(first, { id: "a2", runId: "r2", at: "t3" });
    expect(hasMultipleAssignments(second)).toBe(true);
    expect(assignmentHistory(second).map((entry) => [entry.id, entry.runId])).toEqual([
      ["a1", "r1"],
      ["a2", "r2"],
    ]);
    // The first Assignment's history survives the second one starting.
    expect(second.assignments[0]).toMatchObject({ outcome: "failed", endedAt: "t2" });
    expect(second.state).toBe("open");
  });
});

describe("ending a ticket", () => {
  it("ends once a person says so, recording who and why", () => {
    const ended = endTicket(ticket(), { at: "t9", outcome: "stopped", by: "alice" });
    expect(ended.state).toBe("ended");
    expect(ended.ended).toEqual({ at: "t9", outcome: "stopped", by: "alice" });
    expect(endTicket(ended, { at: "t10", outcome: "closed", by: "alice" })).toBe(ended);
  });

  it("refuses to end while an Assignment runs", () => {
    const running = startAssignment(ticket(), { id: "a1", runId: "r1", at: "t1" });
    expect(() => endTicket(running, { at: "t2", outcome: "dropped", by: "alice" })).toThrow(
      /cannot end while an Assignment runs/,
    );
  });
});

describe("resuming a ticket", () => {
  const resumed = (from: Ticket, patch: Partial<PolicySnapshot> = {}) =>
    resumeTicket(from, { policy: policy(patch), triggerId: "t2", at: "t10" });

  it("accepts a new Trigger on an open Ticket", () => {
    expect(resumed(ticket()).triggerIds).toEqual(["t1", "t2"]);
  });

  it("reopens an ended Ticket under the same Mandate", () => {
    const ended = endTicket(ticket(), { at: "t9", outcome: "merged", by: "github" });
    const back = resumed(ended);
    expect(back.state).toBe("open");
    expect(back.ended).toBeUndefined();
    expect(back.mandate.id).toBe("m1");
    expect(back.triggerIds).toEqual(["t1", "t2"]);
  });

  it("never revives a Ticket a person stopped", () => {
    const stopped = endTicket(ticket(), { at: "t9", outcome: "stopped", by: "alice" });
    expect(() => resumed(stopped)).toThrow(/stopped by a person/);
  });

  it("refuses to reopen under a policy that no longer holds the Mandate", () => {
    const ended = endTicket(ticket(), { at: "t9", outcome: "merged", by: "github" });
    expect(() => resumed(ended, { rules: [] })).toThrow(
      expect.objectContaining({ code: "mandate-revoked" }),
    );
  });

  it("accepts each Trigger once", () => {
    expect(acceptTrigger(ticket(), "t1")).toEqual(ticket());
  });
});

describe("ticket stage", () => {
  it("reads the stage table top to bottom", () => {
    expect(ticketStage(ticket())).toBe("working/queued");

    const running = startAssignment(ticket(), { id: "a1", runId: "r1", at: "t1" });
    expect(ticketStage(running)).toBe("working");

    const failed = endAssignment(running, { id: "a1", at: "t2", outcome: "failed" });
    expect(ticketStage(failed)).toBe("person/blocked");

    const blocked = endAssignment(running, { id: "a1", at: "t2", outcome: "blocked" });
    expect(ticketStage(blocked)).toBe("person/blocked");

    const done = endAssignment(running, { id: "a1", at: "t2", outcome: "completed" });
    expect(ticketStage(done)).toBe("idle");

    const interrupted = endAssignment(running, { id: "a1", at: "t2", outcome: "interrupted" });
    expect(ticketStage(interrupted)).toBe("working");
  });

  it("reports an ended Ticket as ended whatever its Assignments did", () => {
    const running = startAssignment(ticket(), { id: "a1", runId: "r1", at: "t1" });
    const done = endAssignment(running, { id: "a1", at: "t2", outcome: "completed" });
    expect(ticketStage(endTicket(done, { at: "t3", outcome: "merged", by: "github" }))).toBe("ended");
  });
});
