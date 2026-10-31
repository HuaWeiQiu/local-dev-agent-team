import { describe, expect, it } from "vitest";
import {
  describeGateReason,
  evaluateGate,
  isStopRequest,
  stopDecision,
  type GateInput,
  type OpenTicket,
} from "../src/authority/gate.js";
import type { PolicySnapshot } from "../src/authority/types.js";
import { makeTrigger, type Trigger } from "../src/intake/types.js";

const thread = { sourceKind: "github", sourceInstanceId: "acme/demo", threadId: "pull/7" };

function trigger(patch: Record<string, unknown> = {}): Trigger {
  return makeTrigger({
    sourceKind: "github",
    sourceInstanceId: "acme/demo",
    externalId: "comment:1",
    kind: "comment",
    threads: [thread],
    actor: { sourceKind: "github", id: "alice" },
    at: "2026-01-01T00:00:00.000Z",
    ...patch,
  } as never)!;
}

function policy(patch: Partial<PolicySnapshot> = {}): PolicySnapshot {
  return {
    version: "v1",
    allowedActors: ["alice"],
    allowsProactive: false,
    rules: [],
    ...patch,
  };
}

function input(patch: Partial<GateInput> = {}): GateInput {
  return { trigger: trigger(), policy: policy(), openTickets: [], addressed: true, ...patch };
}

function ticket(patch: Partial<OpenTicket> = {}): OpenTicket {
  return { id: "t1", triggerIds: [], paths: [], ...patch };
}

describe("evaluateGate", () => {
  it("accepts an explicit request from an allowed actor", () => {
    const decision = evaluateGate(input());
    expect(decision.outcome).toBe("accept");
    expect(decision.strength).toBe("explicit");
    expect(decision.reasons[0]!.code).toBe("explicit_request");
    expect(decision.mandate).toBeDefined();
  });

  it("refuses an actor the policy does not allow", () => {
    const decision = evaluateGate(input({ policy: policy({ allowedActors: ["bob"] }) }));
    expect(decision).toMatchObject({ outcome: "ignore", strength: "inferred" });
    expect(decision.reasons[0]).toEqual({ code: "actor_not_allowed", values: ["alice"] });
    expect(decision.mandate).toBeUndefined();
  });

  it("refuses inferred work while proactive work is off", () => {
    const decision = evaluateGate(input({ addressed: false }));
    expect(decision.reasons[0]!.code).toBe("proactive_disallowed");
  });

  it("accepts inferred work once proactive work is allowed", () => {
    const decision = evaluateGate(
      input({ addressed: false, policy: policy({ allowsProactive: true }) }),
    );
    expect(decision).toMatchObject({ outcome: "accept", strength: "inferred" });
    expect(decision.reasons[0]!.code).toBe("inferred_request");
  });

  it("treats a wildcard policy as allowing any actor", () => {
    expect(evaluateGate(input({ policy: policy({ allowedActors: ["*"] }) })).outcome).toBe("accept");
  });

  it("refuses a Trigger already owned by an open Ticket", () => {
    const decision = evaluateGate(
      input({ openTickets: [ticket({ triggerIds: [trigger().id] })] }),
    );
    expect(decision.reasons[0]!.code).toBe("duplicate_trigger");
  });

  it("accepts a Trigger an open Ticket does not own", () => {
    expect(evaluateGate(input({ openTickets: [ticket({ triggerIds: ["other"] })] })).outcome).toBe(
      "accept",
    );
  });

  it("reports a Trigger with no Thread as unavailable", () => {
    const bare = { ...trigger(), threads: [] } as Trigger;
    const decision = evaluateGate(input({ trigger: bare }));
    expect(decision.outcome).toBe("unavailable");
    expect(decision.reasons[0]!.code).toBe("no_thread");
  });

  it("decides in a fixed order: actor before proactivity before duplicates", () => {
    const decision = evaluateGate(
      input({
        addressed: false,
        policy: policy({ allowedActors: ["bob"] }),
        openTickets: [ticket({ triggerIds: [trigger().id] })],
      }),
    );
    expect(decision.reasons[0]!.code).toBe("actor_not_allowed");
  });
});

describe("stop requests", () => {
  it("recognises a stop from an allowed actor", () => {
    const withBody = trigger({ payload: { body: "stop please" } });
    expect(isStopRequest({ trigger: withBody, policy: policy(), addressed: true })).toBe(true);
    expect(
      isStopRequest({ trigger: trigger({ payload: { body: "停止" } }), policy: policy(), addressed: true }),
    ).toBe(true);
  });

  it("ignores a stop from someone not allowed, or one not addressed to the agent", () => {
    const withBody = trigger({ payload: { body: "stop" } });
    expect(isStopRequest({ trigger: withBody, policy: policy({ allowedActors: ["bob"] }), addressed: true })).toBe(false);
    expect(isStopRequest({ trigger: withBody, policy: policy(), addressed: false })).toBe(false);
  });

  it("does not read a stop out of ordinary prose", () => {
    expect(
      isStopRequest({ trigger: trigger({ payload: { body: "please fix the stop button" } }), policy: policy(), addressed: true }),
    ).toBe(false);
  });

  it("records a stop as its own decision", () => {
    const decision = stopDecision(trigger());
    expect(decision).toMatchObject({ outcome: "ignore", strength: "explicit" });
    expect(decision.reasons[0]!.code).toBe("stop_requested");
  });
});

describe("describeGateReason", () => {
  it("words every code the gate can produce", () => {
    for (const code of [
      "actor_not_allowed",
      "proactive_disallowed",
      "no_thread",
      "duplicate_trigger",
      "explicit_request",
      "inferred_request",
      "stop_requested",
    ]) {
      const text = describeGateReason({ code, values: ["alice"] });
      expect(text.length).toBeGreaterThan(code.length);
    }
  });

  it("falls back to the code for an unknown reason", () => {
    expect(describeGateReason({ code: "from_a_source" })).toBe("from_a_source");
  });
});
