import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TicketStore } from "../src/authority/ticket-store.js";
import { endAssignment, endTicket, openTicket, startAssignment, type Ticket } from "../src/authority/ticket.js";
import type { Mandate } from "../src/authority/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

async function makeStore(): Promise<{ store: TicketStore; file: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-tickets-"));
  roots.push(root);
  const file = path.join(root, "authority", "tickets.json");
  return { store: new TicketStore(file), file };
}

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
  return openTicket({ id, threadKey: "thread-1", mandate, triggerId: "t1" });
}

describe("TicketStore", () => {
  it("starts empty when the file is missing", async () => {
    const { store } = await makeStore();
    expect(await store.list()).toEqual([]);
    expect(await store.get("nope")).toBeUndefined();
  });

  it("reads back what it wrote", async () => {
    const { store } = await makeStore();
    await store.save(ticket());
    expect(await store.get("tk1")).toMatchObject({ state: "open", threadKey: "thread-1" });
    expect(await store.list()).toHaveLength(1);
  });

  it("replaces a record rather than duplicating it", async () => {
    const { store } = await makeStore();
    await store.save(ticket());
    await store.save(endTicket(ticket(), { at: "t9", outcome: "merged", by: "github" }));
    const tickets = await store.list();
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.state).toBe("ended");
  });

  it("keeps several Tickets apart", async () => {
    const { store } = await makeStore();
    await store.save(ticket("tk1"));
    await store.save(ticket("tk2"));
    expect((await store.list()).map((entry) => entry.id)).toEqual(["tk1", "tk2"]);
  });

  it("survives a Ticket that was worked on twice", async () => {
    const { store } = await makeStore();
    const first = endAssignment(startAssignment(ticket(), { id: "a1", runId: "r1", at: "t1" }), {
      id: "a1",
      at: "t2",
      outcome: "failed",
    });
    const second = startAssignment(first, { id: "a2", runId: "r2", at: "t3" });
    await store.save(second);
    const loaded = await store.get("tk1");
    expect(loaded?.assignments.map((entry) => entry.runId)).toEqual(["r1", "r2"]);
    expect(loaded?.assignments[0]).toMatchObject({ outcome: "failed" });
  });

  it("writes a versioned document", async () => {
    const { store, file } = await makeStore();
    await store.save(ticket());
    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw).toMatchObject({ version: 1 });
    expect(raw.tickets).toHaveLength(1);
  });

  it("reads a file without a tickets array as empty", async () => {
    const { store, file } = await makeStore();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1 }), "utf8");
    expect(await store.list()).toEqual([]);
  });
});
