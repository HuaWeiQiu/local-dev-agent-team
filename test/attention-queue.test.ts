import { describe, expect, it } from "vitest";
import { attentionOf, attentionQueue, workingCount } from "../src/authority/attention.js";
import {
  endAssignment,
  endTicket,
  openTicket,
  startAssignment,
  type Ticket,
} from "../src/authority/ticket.js";
import type { Mandate } from "../src/authority/types.js";

const mandate: Mandate = {
  id: "m1",
  triggerId: "t1",
  policyVersion: "v1",
  scope: ["src/a"],
  strength: "explicit",
  actor: { sourceKind: "github", id: "alice" },
  sourceKind: "github",
  reliedOn: ["gate:plan"],
  grantedAt: "2026-01-01T00:00:00.000Z",
};

function ticket(id = "tk1"): Ticket {
  return openTicket({ id, threadKey: `thread-${id}`, mandate, triggerId: "t1" });
}

function running(id = "tk1"): Ticket {
  return startAssignment(ticket(id), { id: `a-${id}`, runId: `r-${id}`, at: "2026-01-01T01:00:00Z" });
}

function endedWith(outcome: "completed" | "failed" | "blocked", id = "tk1"): Ticket {
  const started = running(id);
  return endAssignment(started, { id: `a-${id}`, at: "2026-01-01T02:00:00Z", outcome });
}

describe("attentionOf", () => {
  it("says nothing for work that needs nobody", () => {
    expect(attentionOf(ticket())).toBeUndefined();
    expect(attentionOf(running())).toBeUndefined();
    expect(attentionOf(endedWith("completed"))).toBeUndefined();
  });

  it("reports a blocked Ticket", () => {
    expect(attentionOf(endedWith("blocked"))).toMatchObject({ kind: "blocked", since: "2026-01-01T02:00:00Z" });
  });

  it("tells a failure apart from a block", () => {
    expect(attentionOf(endedWith("failed"))?.kind).toBe("failed");
  });

  it("reports an undelivered Input first", () => {
    const undelivered = { ...running(), delivery: { error: "no route", at: "2026-01-01T03:00:00Z" } };
    expect(attentionOf(undelivered)).toMatchObject({ kind: "delivery-failed" });
  });

  it("says nothing for an ended Ticket, however it ended", () => {
    const stopped = endTicket(endedWith("blocked"), { at: "t9", outcome: "stopped", by: "alice" });
    expect(attentionOf(stopped)).toBeUndefined();
  });
});

describe("attentionQueue", () => {
  it("puts the most urgent first", () => {
    const undelivered = { ...running("tk-a"), delivery: { error: "x", at: "2026-01-01T03:00:00Z" } };
    const queue = attentionQueue([
      endedWith("blocked", "tk-b"),
      undelivered,
      endedWith("failed", "tk-c"),
    ]);
    expect(queue.map((entry) => entry.kind)).toEqual(["delivery-failed", "blocked", "failed"]);
  });

  it("puts the oldest first within one kind", () => {
    const older = endAssignment(running("tk-old"), { id: "a-tk-old", at: "2026-01-01T01:00:00Z", outcome: "blocked" });
    const newer = endAssignment(running("tk-new"), { id: "a-tk-new", at: "2026-01-01T05:00:00Z", outcome: "blocked" });
    expect(attentionQueue([newer, older]).map((entry) => entry.ticketId)).toEqual(["tk-old", "tk-new"]);
  });

  it("leaves healthy work out of the queue", () => {
    expect(attentionQueue([ticket(), running(), endedWith("completed")])).toEqual([]);
  });
});

describe("workingCount", () => {
  it("counts only what moves without anyone", () => {
    expect(workingCount([ticket(), running(), endedWith("blocked"), endedWith("completed")])).toBe(2);
  });

  it("counts nothing when everything needs a person", () => {
    expect(workingCount([endedWith("blocked"), endedWith("failed", "tk2")])).toBe(0);
  });
});
