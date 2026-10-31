import { describe, expect, it } from "vitest";
import { addressesAgent, admissionThread, readAdmission } from "../src/intake/admission.js";
import { makeTrigger } from "../src/intake/types.js";
import { evaluateGate } from "../src/authority/gate.js";
import type { PolicySnapshot } from "../src/authority/types.js";

const policy: PolicySnapshot = {
  version: "v1",
  allowedActors: ["alice"],
  allowsProactive: false,
  rules: ["gate:plan"],
};

const decide = (trigger: Parameters<typeof evaluateGate>[0]["trigger"], addressed: boolean) =>
  evaluateGate({ trigger, policy, addressed, openTickets: [] });

function comment(body: string, login = "alice"): Record<string, unknown> {
  return {
    repository: { full_name: "acme/demo" },
    issue: { number: 7, pull_request: { url: "x" } },
    comment: { id: 900, body, user: { login }, created_at: "2026-01-01T00:00:00Z" },
  };
}

describe("readAdmission", () => {
  it("admits a comment that names the agent", () => {
    const result = readAdmission({
      request: { event: "issue_comment", payload: comment("@agent-bot please fix"), agentLogins: ["agent-bot"] },
      decide,
    });
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0]).toMatchObject({ addressed: true });
    expect(result.verdicts[0]!.decision.outcome).toBe("accept");
  });

  it("refuses a comment that merely mentions the thread", () => {
    const result = readAdmission({
      request: { event: "issue_comment", payload: comment("looks good to me"), agentLogins: ["agent-bot"] },
      decide,
    });
    expect(result.verdicts[0]).toMatchObject({ addressed: false });
    expect(result.verdicts[0]!.decision.reasons[0]!.code).toBe("proactive_disallowed");
  });

  it("refuses everything when the agent has no login configured", () => {
    const result = readAdmission({
      request: { event: "issue_comment", payload: comment("@agent-bot please fix"), agentLogins: [] },
      decide,
    });
    expect(result.verdicts[0]!.addressed).toBe(false);
    expect(result.verdicts[0]!.decision.outcome).toBe("ignore");
  });

  it("reports an event it does not listen to and starts nothing", () => {
    const result = readAdmission({
      request: { event: "push", payload: comment("@agent-bot go"), agentLogins: ["agent-bot"] },
      decide,
    });
    expect(result.verdicts).toEqual([]);
    expect(result.dropped[0]!.code).toBe("not-listened");
  });

  it("drops another repository's event", () => {
    const result = readAdmission({
      request: {
        event: "issue_comment",
        payload: { ...comment("@agent-bot go"), repository: { full_name: "other/repo" } },
        agentLogins: ["agent-bot"],
        instanceId: "acme/demo",
      },
      decide,
    });
    expect(result.verdicts).toEqual([]);
    expect(result.dropped[0]!.code).toBe("other-repository");
  });
});

describe("addressing", () => {
  const trigger = makeTrigger({
    sourceKind: "github",
    sourceInstanceId: "acme/demo",
    externalId: "comment:1",
    kind: "comment",
    threads: [{ sourceKind: "github", sourceInstanceId: "acme/demo", threadId: "pull/7" }],
    actor: { sourceKind: "github", id: "alice" },
    at: "2026-01-01T00:00:00.000Z",
    payload: { body: "hey @agent-bot have a look" },
  })!;

  it("reads a login mention", () => {
    expect(addressesAgent(trigger, ["agent-bot"])).toBe(true);
    expect(addressesAgent(trigger, ["someone-else"])).toBe(false);
  });

  it("ignores a trigger without a body", () => {
    const bare = { ...trigger, payload: undefined } as typeof trigger;
    expect(addressesAgent(bare, ["agent-bot"])).toBe(false);
  });

  it("names the thread the work would run on", () => {
    expect(admissionThread(trigger)).toContain("pull/7");
  });
});

describe("repository resolution", () => {
  it("falls back to the payload's repository when the Source names none", () => {
    const result = readAdmission({
      request: { event: "issue_comment", payload: comment("@agent-bot go"), agentLogins: ["agent-bot"] },
      decide,
    });
    expect(result.verdicts).toHaveLength(1);
    expect(admissionThread(result.verdicts[0]!.trigger)).toContain("pull/7");
  });

  it("starts nothing from a payload it cannot read", () => {
    const result = readAdmission({
      request: { event: "issue_comment", payload: "not an object", agentLogins: ["agent-bot"] },
      decide,
    });
    expect(result.verdicts).toEqual([]);
    expect(result.dropped[0]!.code).toBe("incomplete");
  });
});
