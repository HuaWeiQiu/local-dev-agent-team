import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TicketService } from "../src/authority/ticket-service.js";
import { TicketStore } from "../src/authority/ticket-store.js";
import { isSubscribed, subscribe, unsubscribe } from "../src/authority/ticket.js";
import type { PolicySnapshot } from "../src/authority/types.js";
import { makeTrigger, threadKey, type Trigger } from "../src/intake/types.js";

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

function trigger(externalId: string, threadId = "pull/7", body = "@agent go"): Trigger {
  return makeTrigger({
    sourceKind: "github",
    sourceInstanceId: "acme/demo",
    externalId,
    kind: "comment",
    threads: [{ sourceKind: "github", sourceInstanceId: "acme/demo", threadId }],
    actor: { sourceKind: "github", id: "alice" },
    at: "2026-01-01T00:00:00.000Z",
    payload: { body },
  })!;
}

/** The composed key a Subscription stores, not a bare thread id. */
function pullKey(threadId: string): string {
  return threadKey({ sourceKind: "github", sourceInstanceId: "acme/demo", threadId });
}

async function service(patch: Partial<PolicySnapshot> = {}): Promise<TicketService> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-subscription-"));
  roots.push(root);
  let tick = 0;
  return new TicketService({
    store: new TicketStore(path.join(root, "tickets.json")),
    policy: () => policy(patch),
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    newId: () => `id-${tick++}`,
  });
}

describe("subscription direct pass", () => {
  it("takes a follow-up on the same Thread without consulting the gate", async () => {
    // The policy would refuse this follow-up on its own: nobody addressed the
    // agent and proactive work is off. The direct pass must still take it.
    const tickets = await service();
    const first = await tickets.admit({ trigger: trigger("c1"), addressed: true });
    expect(first.decision.outcome).toBe("accept");

    const second = await tickets.admit({ trigger: trigger("c2"), addressed: false });
    expect(second.decision.reasons[0]!.code).toBe("subscription_direct_pass");
    expect(second.ticket?.id).toBe(first.ticket?.id);
    expect(second.ticket?.triggerIds).toHaveLength(2);
  });

  it("still refuses a duplicate delivered twice", async () => {
    const tickets = await service();
    await tickets.admit({ trigger: trigger("c1"), addressed: true });
    const again = await tickets.admit({ trigger: trigger("c1"), addressed: true });
    expect(again.decision.reasons[0]!.code).toBe("duplicate_trigger");
  });

  it("never lets a refused Trigger create a subscription", async () => {
    const tickets = await service();
    const refused = await tickets.admit({ trigger: trigger("c1"), addressed: false });
    expect(refused.decision.outcome).toBe("ignore");
    expect(await tickets.list()).toEqual([]);
    // The Thread has no Ticket, so the next event is judged on its own.
    const later = await tickets.admit({ trigger: trigger("c2"), addressed: false });
    expect(later.decision.reasons[0]!.code).toBe("proactive_disallowed");
  });

  it("judges a follow-up on a different Thread on its own", async () => {
    const tickets = await service();
    await tickets.admit({ trigger: trigger("c1"), addressed: true });
    const other = await tickets.admit({ trigger: trigger("c2", "issue/9"), addressed: false });
    expect(other.decision.reasons[0]!.code).toBe("proactive_disallowed");
  });

  it("routes a subscribed Thread to the Ticket that subscribed it", async () => {
    const tickets = await service();
    const first = await tickets.admit({ trigger: trigger("c1"), addressed: true });
    await tickets.subscribe(first.ticket!.id, pullKey("pr/99"));

    const fromPull = await tickets.admit({ trigger: trigger("c2", "pr/99"), addressed: false });
    expect(fromPull.decision.reasons[0]!.code).toBe("subscription_direct_pass");
    expect(fromPull.ticket?.id).toBe(first.ticket!.id);
  });

  it("returns to the gate once a Thread is unsubscribed", async () => {
    const tickets = await service();
    const first = await tickets.admit({ trigger: trigger("c1"), addressed: true });
    await tickets.subscribe(first.ticket!.id, pullKey("pr/99"));
    await tickets.unsubscribe(first.ticket!.id, pullKey("pr/99"));

    const back = await tickets.admit({ trigger: trigger("c2", "pr/99"), addressed: false });
    expect(back.decision.reasons[0]!.code).toBe("proactive_disallowed");
  });
});

describe("subscription rules", () => {
  const base = {
    id: "tk1",
    threadKey: "own",
    subscriptions: ["own"],
    mandate: {} as never,
    triggerIds: ["t1"],
    state: "open" as const,
    assignments: [],
  };

  it("always keeps the Ticket's own Thread", () => {
    const without = unsubscribe(base, "own");
    expect(without.subscriptions).toEqual(["own"]);
    expect(isSubscribed(without, "own")).toBe(true);
  });

  it("adds a Thread once", () => {
    expect(subscribe(base, "other").subscriptions).toEqual(["own", "other"]);
    expect(subscribe(subscribe(base, "other"), "other").subscriptions).toEqual(["own", "other"]);
  });

  it("does not subscribe an ended Ticket", () => {
    const ended = { ...base, state: "ended" as const };
    expect(isSubscribed(ended, "own")).toBe(false);
  });
});
