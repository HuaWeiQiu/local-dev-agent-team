import { describe, expect, it } from "vitest";
import {
  MandateError,
  needsMandate,
  assertMandateUsable,
  assertWithinScope,
  grantMandate,
  planScope,
} from "../src/authority/mandate.js";
import { actorAllowed, policyFactsFrom, policySnapshot, policyVersion } from "../src/authority/policy.js";
import type { PolicySnapshot } from "../src/authority/types.js";
import type { ApprovalResponse, RunState } from "../src/state/types.js";

const response = (patch: Partial<ApprovalResponse> = {}): ApprovalResponse => ({
  decision: "approved",
  actor: "alice",
  reason: "looks right",
  respondedAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});

const policy = (patch: Partial<PolicySnapshot> = {}): PolicySnapshot => ({
  version: "v1",
  allowedActors: ["*"],
  allowsProactive: false,
  rules: ["gate:plan", "strategy:balanced"],
  ...patch,
});

function run(tasks: Array<{ ownedPaths: string[] }>): Pick<RunState, "tasks"> {
  return {
    tasks: tasks.map((task) => ({
      task: { id: "T1", ownedPaths: task.ownedPaths } as never,
      status: "pending" as never,
      attempts: 0,
    })),
  } as Pick<RunState, "tasks">;
}

describe("planScope", () => {
  it("collects every owned path once, in order", () => {
    expect(planScope(run([{ ownedPaths: ["src/a"] }, { ownedPaths: ["src/a", "src/b"] }]))).toEqual([
      "src/a",
      "src/b",
    ]);
  });

  it("is empty for a run without tasks", () => {
    expect(planScope(run([]))).toEqual([]);
  });
});

describe("grantMandate", () => {
  it("records the policy version, scope, actor and rules it relied on", () => {
    const mandate = grantMandate({
      runId: "run-1",
      approvalId: "ap-1",
      response: response(),
      policy: policy(),
      scope: ["src/a"],
      strength: "explicit",
    });
    expect(mandate).toMatchObject({
      id: "run-1:ap-1",
      triggerId: "run-1",
      policyVersion: "v1",
      scope: ["src/a"],
      strength: "explicit",
      reliedOn: ["gate:plan", "strategy:balanced"],
    });
    expect(mandate.actor).toEqual({ sourceKind: "local-cli", id: "alice" });
  });

  it("refuses a rejection and an empty scope", () => {
    expect(() =>
      grantMandate({
        runId: "r",
        approvalId: "a",
        response: response({ decision: "rejected" }),
        policy: policy(),
        scope: ["src/a"],
        strength: "explicit",
      }),
    ).toThrow(MandateError);
    expect(() =>
      grantMandate({
        runId: "r",
        approvalId: "a",
        response: response(),
        policy: policy(),
        scope: [],
        strength: "explicit",
      }),
    ).toThrow(/no owned paths/);
  });
});

describe("assertMandateUsable", () => {
  const mandate = grantMandate({
    runId: "run-1",
    approvalId: "ap-1",
    response: response(),
    policy: policy(),
    scope: ["src/a"],
    strength: "explicit",
  });

  it("allows a resume while the policy still holds", () => {
    expect(() => assertMandateUsable(mandate, policy(), "resume")).not.toThrow();
  });

  it("refuses a run without a Mandate", () => {
    expect(() => assertMandateUsable(undefined, policy(), "retry")).toThrow(/no recorded Mandate/);
  });

  it("refuses a resume whose policy dropped a rule it relied on", () => {
    expect(() => assertMandateUsable(mandate, policy({ rules: ["gate:plan"] }), "resume")).toThrow(
      /policy-changed-rules/,
    );
  });

  it("refuses a resume whose actor is no longer allowed", () => {
    expect(() =>
      assertMandateUsable(mandate, policy({ allowedActors: ["bob"] }), "resume"),
    ).toThrow(/actor-not-allowed/);
  });

  it("names the action in the message", () => {
    expect(() => assertMandateUsable(undefined, policy(), "retry")).toThrow(/Cannot retry/);
  });
});

describe("assertWithinScope", () => {
  const mandate = grantMandate({
    runId: "r",
    approvalId: "a",
    response: response(),
    policy: policy(),
    scope: ["src/a"],
    strength: "explicit",
  });

  it("accepts paths inside the scope", () => {
    expect(() => assertWithinScope(mandate, ["src/a", "src/a/b.ts"])).not.toThrow();
  });

  it("refuses a path outside it", () => {
    expect(() => assertWithinScope(mandate, ["src/a", "src/elsewhere"])).toThrow(/does not cover/);
  });
});

describe("policy snapshot", () => {
  const facts = {
    project: "demo",
    strategy: "balanced",
    roles: ["worker", "architect"],
    gates: ["plan", "final"],
    allowedActors: ["*"],
    allowsProactive: false,
    rules: ["gate:plan", "gate:final", "strategy:balanced"],
  };

  it("is order-independent", () => {
    expect(policyVersion(facts)).toBe(policyVersion({ ...facts, roles: ["architect", "worker"] }));
    expect(policyVersion({ ...facts, rules: [...facts.rules].reverse() })).toBe(policyVersion(facts));
  });

  it("changes when a fact changes", () => {
    expect(policyVersion({ ...facts, strategy: "fast" })).not.toBe(policyVersion(facts));
    expect(policyVersion({ ...facts, allowsProactive: true })).not.toBe(policyVersion(facts));
  });

  it("builds a snapshot the revocation check accepts", () => {
    const snapshot = policySnapshot(facts);
    expect(snapshot.version).toHaveLength(16);
    expect(snapshot.allowedActors).toEqual(["*"]);
  });

  it("reads facts from a configuration", () => {
    const loaded = {
      project: { name: "demo" },
      roles: { worker: {}, architect: {} },
    } as never;
    const read = policyFactsFrom(loaded, "balanced");
    expect(read).toMatchObject({ project: "demo", strategy: "balanced", allowsProactive: false });
    expect(read.rules).toContain("strategy:balanced");
  });

  it("treats a wildcard as allowing any actor", () => {
    expect(actorAllowed("anyone", ["*"])).toBe(true);
    expect(actorAllowed("alice", ["alice"])).toBe(true);
    expect(actorAllowed("bob", ["alice"])).toBe(false);
  });
});

describe("needsMandate", () => {
  it("is true only once a gate was approved", () => {
    expect(needsMandate({ approvals: [] })).toBe(false);
    expect(needsMandate({})).toBe(false);
    expect(needsMandate({ approvals: [{ status: "pending" } as never] })).toBe(false);
    expect(needsMandate({ approvals: [{ status: "rejected" } as never] })).toBe(false);
    expect(needsMandate({ approvals: [{ status: "approved" } as never] })).toBe(true);
  });
});
