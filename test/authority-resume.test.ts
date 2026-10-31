import { describe, expect, it } from "vitest";
import { MandateError, assertMandateUsable, grantMandate, planScope } from "../src/authority/mandate.js";
import { policyFactsFrom, policySnapshot } from "../src/authority/policy.js";

/**
 * The resume rule, exercised without a server: a run with an approved gate must
 * carry a Mandate, and that Mandate must still hold under the current policy.
 */
const config = {
  project: { name: "demo" },
  roles: { worker: {}, architect: {} },
} as never;

function mandate() {
  const facts = policyFactsFrom(config, "balanced");
  return grantMandate({
    runId: "run-1",
    approvalId: "ap-1",
    response: {
      decision: "approved",
      actor: "alice",
      reason: "ok",
      respondedAt: "2026-01-01T00:00:00.000Z",
    },
    policy: policySnapshot(facts),
    scope: ["src/workflow"],
    strength: "explicit",
  });
}

describe("resume authority", () => {
  it("passes while the configuration is unchanged", () => {
    const facts = policyFactsFrom(config, "balanced");
    expect(() => assertMandateUsable(mandate(), policySnapshot(facts), "resume")).not.toThrow();
  });

  it("fails once the strategy changed under it", () => {
    const facts = policyFactsFrom(config, "fast");
    expect(() => assertMandateUsable(mandate(), policySnapshot(facts), "resume")).toThrow(
      MandateError,
    );
    expect(() => assertMandateUsable(mandate(), policySnapshot(facts), "resume")).toThrow(
      /policy-changed-rules/,
    );
  });

  it("changes version when the roles change", () => {
    const before = policySnapshot(policyFactsFrom(config, "balanced")).version;
    const after = policySnapshot(
      policyFactsFrom({ ...(config as object), roles: { worker: {} } } as never, "balanced"),
    ).version;
    expect(after).not.toBe(before);
  });

  it("scopes the mandate to the plan's owned paths", () => {
    const scope = planScope({
      tasks: [{ task: { ownedPaths: ["src/a"] } as never, status: "pending" as never, attempts: 0 }],
    } as never);
    expect(scope).toEqual(["src/a"]);
  });
});
