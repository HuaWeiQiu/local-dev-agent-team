import { describe, expect, it } from "vitest";
import {
  mandateCovers,
  mandateHolds,
  mandateRevocation,
  sameMandate,
  type Mandate,
  type PolicySnapshot,
} from "../src/authority/types.js";
import {
  makeTrigger,
  primaryThread,
  sharesThread,
  threadKey,
  triggerIdentity,
  uniqueThreads,
  type ThreadRef,
  type TriggerDraft,
} from "../src/intake/types.js";

const thread = (patch: Partial<ThreadRef> = {}): ThreadRef => ({
  sourceKind: "github",
  sourceInstanceId: "repo-a",
  threadId: "pull/1",
  ...patch,
});

const draft = (patch: Partial<TriggerDraft> = {}): TriggerDraft => ({
  sourceKind: "github",
  sourceInstanceId: "repo-a",
  externalId: "evt-1",
  kind: "request",
  threads: [thread()],
  actor: { sourceKind: "github", id: "alice" },
  at: "2026-01-01T00:00:00.000Z",
  ...patch,
});

const policy = (patch: Partial<PolicySnapshot> = {}): PolicySnapshot => ({
  version: "p1",
  allowedActors: ["alice"],
  allowsProactive: true,
  rules: ["small-change", "docs-ok"],
  ...patch,
});

const mandate = (patch: Partial<Mandate> = {}): Mandate => ({
  id: "m1",
  triggerId: "t1",
  policyVersion: "p1",
  scope: ["src/workflow"],
  strength: "explicit",
  actor: { sourceKind: "github", id: "alice" },
  sourceKind: "github",
  reliedOn: ["small-change"],
  grantedAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});

describe("trigger identity", () => {
  it("is stable for the same external event", () => {
    expect(triggerIdentity(draft())).toBe(triggerIdentity(draft()));
    expect(triggerIdentity(draft())).toBe("github\u0000repo-a\u0000evt-1");
  });

  it("separates Sources, instances and events", () => {
    const base = triggerIdentity(draft());
    expect(triggerIdentity(draft({ sourceInstanceId: "repo-b" }))).not.toBe(base);
    expect(triggerIdentity(draft({ externalId: "evt-2" }))).not.toBe(base);
    expect(triggerIdentity(draft({ sourceKind: "ci" }))).not.toBe(base);
  });
});

describe("makeTrigger", () => {
  it("builds a Trigger with its identity", () => {
    const trigger = makeTrigger(draft());
    expect(trigger).toMatchObject({ id: triggerIdentity(draft()), kind: "request" });
    expect(trigger?.threads).toHaveLength(1);
  });

  it("refuses a draft without a Thread, an instance or an external id", () => {
    expect(makeTrigger(draft({ threads: [] }))).toBeUndefined();
    expect(makeTrigger(draft({ sourceInstanceId: "  " }))).toBeUndefined();
    expect(makeTrigger(draft({ externalId: "" }))).toBeUndefined();
  });

  it("keeps the payload only when the Source gave one", () => {
    expect(makeTrigger(draft())).not.toHaveProperty("payload");
    expect(makeTrigger(draft({ payload: { n: 1 } }))?.payload).toEqual({ n: 1 });
  });
});

describe("threads", () => {
  it("takes the first Thread as primary and de-duplicates the rest", () => {
    const trigger = makeTrigger(
      draft({ threads: [thread(), thread(), thread({ threadId: "issue/7" })] }),
    )!;
    expect(primaryThread(trigger)?.threadId).toBe("pull/1");
    expect(uniqueThreads(trigger).map((entry) => entry.threadId)).toEqual(["pull/1", "issue/7"]);
  });

  it("keys a Thread by Source, instance and id", () => {
    expect(threadKey(thread())).toBe("github\u0000repo-a\u0000pull/1");
  });

  it("reports correlation through a shared Thread", () => {
    const a = makeTrigger(draft())!;
    const b = makeTrigger(draft({ externalId: "evt-2" }))!;
    const c = makeTrigger(draft({ externalId: "evt-3", threads: [thread({ threadId: "issue/9" })] }))!;
    expect(sharesThread(a, b)).toBe(true);
    expect(sharesThread(a, c)).toBe(false);
  });
});

describe("mandate revocation", () => {
  it("holds while the policy still allows the actor and every relied-on rule", () => {
    expect(mandateHolds(mandate(), policy())).toBe(true);
    expect(mandateRevocation(mandate(), policy())).toBeUndefined();
  });

  it("revokes when the actor is no longer allowed", () => {
    expect(mandateRevocation(mandate(), policy({ allowedActors: ["bob"] }))?.code).toBe(
      "actor-not-allowed",
    );
  });

  it("revokes when a relied-on rule is gone", () => {
    const revoked = mandateRevocation(mandate(), policy({ rules: ["docs-ok"] }));
    expect(revoked?.code).toBe("policy-changed-rules");
    expect(revoked?.detail).toContain("small-change");
  });

  it("revokes inferred work when proactive work is disallowed", () => {
    expect(
      mandateRevocation(mandate({ strength: "inferred" }), policy({ allowsProactive: false }))?.code,
    ).toBe("proactive-disallowed");
    // An explicit request is unaffected by that switch.
    expect(mandateHolds(mandate({ strength: "explicit" }), policy({ allowsProactive: false }))).toBe(
      true,
    );
  });

  it("does not revoke on a policy version change alone", () => {
    expect(mandateHolds(mandate(), policy({ version: "p2" }))).toBe(true);
  });
});

describe("mandate scope", () => {
  it("covers the scope root and everything under it", () => {
    expect(mandateCovers(mandate(), "src/workflow")).toBe(true);
    expect(mandateCovers(mandate(), "src/workflow/runner.ts")).toBe(true);
    expect(mandateCovers(mandate(), "./src/workflow/runner.ts")).toBe(true);
  });

  it("does not cover a sibling or a prefix that only looks similar", () => {
    expect(mandateCovers(mandate(), "src/workflows")).toBe(false);
    expect(mandateCovers(mandate(), "src/state")).toBe(false);
    expect(mandateCovers(mandate(), "src/workflow-extra/x.ts")).toBe(false);
  });

  it("treats an empty scope as covering nothing", () => {
    expect(mandateCovers(mandate({ scope: [] }), "src/workflow")).toBe(false);
  });
});

describe("sameMandate", () => {
  it("compares every recorded fact", () => {
    expect(sameMandate(mandate(), mandate())).toBe(true);
    expect(sameMandate(mandate(), mandate({ id: "m2" }))).toBe(false);
    expect(sameMandate(mandate(), mandate({ strength: "inferred" }))).toBe(false);
    expect(sameMandate(mandate(), mandate({ scope: ["src/state"] }))).toBe(false);
    expect(sameMandate(mandate(), mandate({ reliedOn: [] }))).toBe(false);
  });
});
