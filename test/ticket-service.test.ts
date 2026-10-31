import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TicketService } from "../src/authority/ticket-service.js";
import { TicketStore } from "../src/authority/ticket-store.js";
import type { PolicySnapshot } from "../src/authority/types.js";
import { makeTrigger, type Trigger } from "../src/intake/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

const policy = (patch: Partial<PolicySnapshot> = {}): PolicySnapshot => ({
  version: "v1",
  allowedActors: ["alice"],
  allowsProactive: false,
  rules: ["gate:plan"],
  ...patch,
});

function trigger(externalId = "comment:1", patch: Record<string, unknown> = {}): Trigger {
  return makeTrigger({
    sourceKind: "github",
    sourceInstanceId: "acme/demo",
    externalId,
    kind: "comment",
    threads: [
      { sourceKind: "github", sourceInstanceId: "acme/demo", threadId: "pull/7" },
    ],
    actor: { sourceKind: "github", id: "alice" },
    at: "2026-01-01T00:00:00.000Z",
    ...patch,
  } as never)!;
}

async function service(patch: Partial<PolicySnapshot> = {}): Promise<TicketService> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-ticket-service-"));
  roots.push(root);
  let tick = 0;
  return new TicketService({
    store: new TicketStore(path.join(root, "tickets.json")),
    policy: () => policy(patch),
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    newId: () => `id-${tick++}`,
  });
}

describe("admit", () => {
  it("opens a Ticket on an accept and records the Mandate", async () => {
    const tickets = await service();
    const admission = await tickets.admit({ trigger: trigger(), addressed: true, scope: ["src/a"] });
    expect(admission.decision.outcome).toBe("accept");
    expect(admission.ticket).toMatchObject({ state: "open", threadKey: expect.stringContaining("pull/7") });
    expect(admission.ticket?.mandate).toMatchObject({ scope: ["src/a"], policyVersion: "v1" });
  });

  it("adds a second Trigger from the same Thread to the same Ticket", async () => {
    const tickets = await service();
    const first = await tickets.admit({ trigger: trigger("comment:1"), addressed: true });
    const second = await tickets.admit({ trigger: trigger("comment:2"), addressed: true });
    expect(second.ticket?.id).toBe(first.ticket?.id);
    expect(second.ticket?.triggerIds).toEqual([trigger("comment:1").id, trigger("comment:2").id]);
    expect(await tickets.list()).toHaveLength(1);
  });

  it("changes nothing when the gate refuses", async () => {
    const tickets = await service({ allowedActors: ["bob"] });
    const admission = await tickets.admit({ trigger: trigger(), addressed: true });
    expect(admission.decision.outcome).toBe("ignore");
    expect(admission.ticket).toBeUndefined();
    expect(await tickets.list()).toEqual([]);
  });

  it("refuses the same Trigger twice as a duplicate", async () => {
    const tickets = await service();
    await tickets.admit({ trigger: trigger("comment:1"), addressed: true });
    const again = await tickets.admit({ trigger: trigger("comment:1"), addressed: true });
    expect(again.decision.reasons[0]!.code).toBe("duplicate_trigger");
  });

  it("opens separate Tickets on separate Threads", async () => {
    const tickets = await service();
    await tickets.admit({ trigger: trigger("c1"), addressed: true });
    await tickets.admit({
      trigger: trigger("c2", {
        threads: [{ sourceKind: "github", sourceInstanceId: "acme/demo", threadId: "issue/9" }],
      }),
      addressed: true,
    });
    expect(await tickets.list()).toHaveLength(2);
  });
});

describe("assignments", () => {
  it("binds a run to the Ticket and reports it running", async () => {
    const tickets = await service();
    const admission = await tickets.admit({ trigger: trigger(), addressed: true });
    const attached = await tickets.attachRun({ ticketId: admission.ticket!.id, runId: "run-1" });
    expect(attached.assignments.map((entry) => entry.runId)).toEqual(["run-1"]);
    expect(await tickets.runningRunId(admission.ticket!.id)).toBe("run-1");
  });

  it("refuses a second run while one is still running", async () => {
    const tickets = await service();
    const admission = await tickets.admit({ trigger: trigger(), addressed: true });
    await tickets.attachRun({ ticketId: admission.ticket!.id, runId: "run-1" });
    await expect(
      tickets.attachRun({ ticketId: admission.ticket!.id, runId: "run-2" }),
    ).rejects.toThrow(/already has a running Assignment/);
  });

  it("keeps the Ticket open after a failed run and allows the retry", async () => {
    const tickets = await service();
    const admission = await tickets.admit({ trigger: trigger(), addressed: true });
    const id = admission.ticket!.id;
    await tickets.attachRun({ ticketId: id, runId: "run-1" });
    const settled = await tickets.settleRun({ ticketId: id, runId: "run-1", outcome: "failed" });
    expect(settled.state).toBe("open");
    expect(await tickets.runningRunId(id)).toBeUndefined();

    const retried = await tickets.attachRun({ ticketId: id, runId: "run-2" });
    expect(retried.assignments.map((entry) => [entry.runId, entry.state])).toEqual([
      ["run-1", "ended"],
      ["run-2", "running"],
    ]);
  });

  it("ignores a settle for a run it does not have", async () => {
    const tickets = await service();
    const admission = await tickets.admit({ trigger: trigger(), addressed: true });
    const id = admission.ticket!.id;
    const settled = await tickets.settleRun({ ticketId: id, runId: "ghost", outcome: "completed" });
    expect(settled.assignments).toEqual([]);
  });
});

describe("closing and resuming", () => {
  it("closes a Ticket once no run holds it, and refuses while one does", async () => {
    const tickets = await service();
    const admission = await tickets.admit({ trigger: trigger(), addressed: true });
    const id = admission.ticket!.id;
    await tickets.attachRun({ ticketId: id, runId: "run-1" });
    await expect(tickets.close({ ticketId: id, outcome: "merged", by: "github" })).rejects.toThrow(
      /cannot end while an Assignment runs/,
    );
    await tickets.settleRun({ ticketId: id, runId: "run-1", outcome: "completed" });
    const closed = await tickets.close({ ticketId: id, outcome: "merged", by: "github" });
    expect(closed.state).toBe("ended");
  });

  it("reopens an ended Ticket under the same Mandate", async () => {
    const tickets = await service();
    const admission = await tickets.admit({ trigger: trigger(), addressed: true });
    const id = admission.ticket!.id;
    await tickets.close({ ticketId: id, outcome: "merged", by: "github" });
    const resumed = await tickets.resume({ ticketId: id, trigger: trigger("comment:2") });
    expect(resumed.state).toBe("open");
    expect(resumed.mandate.id).toBe(admission.ticket!.mandate.id);
  });

  it("refuses to reopen a stopped Ticket", async () => {
    const tickets = await service();
    const admission = await tickets.admit({ trigger: trigger(), addressed: true });
    const id = admission.ticket!.id;
    await tickets.close({ ticketId: id, outcome: "stopped", by: "alice" });
    await expect(tickets.resume({ ticketId: id, trigger: trigger("comment:2") })).rejects.toThrow(
      /stopped by a person/,
    );
  });

  it("reports a missing Ticket", async () => {
    const tickets = await service();
    await expect(tickets.attachRun({ ticketId: "nope", runId: "r" })).rejects.toThrow(/was not found/);
  });
});
