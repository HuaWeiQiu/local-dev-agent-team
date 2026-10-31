import { describe, expect, it } from "vitest";
import { githubIntake } from "../src/intake/github-source.js";
import { makeTrigger, primaryThread } from "../src/intake/types.js";

const context = { instanceId: "acme/demo", selfLogins: ["agent-bot"] };

function payload(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repository: { full_name: "acme/demo" },
    issue: { number: 12 },
    comment: { id: 900, body: "please fix", user: { login: "alice" }, created_at: "2026-01-01T00:00:00Z" },
    ...patch,
  };
}

describe("githubIntake routing", () => {
  it("drops an event it does not listen to", () => {
    const result = githubIntake("push", payload(), context);
    expect(result.drafts).toEqual([]);
    expect(result.dropped[0]!.code).toBe("not-listened");
  });

  it("honours an explicit listen list", () => {
    const result = githubIntake("issue_comment", payload(), { ...context, listened: ["check_run"] });
    expect(result.dropped[0]!.code).toBe("not-listened");
  });

  it("drops another repository's event", () => {
    const result = githubIntake("issue_comment", payload({ repository: { full_name: "other/repo" } }), context);
    expect(result.dropped[0]!.code).toBe("other-repository");
  });

  it("drops the agent's own comment", () => {
    const result = githubIntake(
      "issue_comment",
      payload({ comment: { id: 1, user: { login: "agent-bot" }, created_at: "x" } }),
      context,
    );
    expect(result.dropped[0]!.code).toBe("incomplete");
    expect(result.drafts).toEqual([]);
  });

  it("reports a payload without an object as incomplete", () => {
    expect(githubIntake("issue_comment", null, context).dropped[0]!.code).toBe("incomplete");
  });
});

describe("githubIntake triggers", () => {
  it("turns an issue comment into one Trigger on the issue thread", () => {
    const { drafts } = githubIntake("issue_comment", payload(), context);
    expect(drafts).toHaveLength(1);
    const trigger = makeTrigger(drafts[0]!)!;
    expect(trigger.kind).toBe("comment");
    expect(primaryThread(trigger)?.threadId).toBe("issue/12");
    expect(trigger.actor).toEqual({ sourceKind: "github", id: "alice" });
  });

  it("puts a pull request comment on the pull thread", () => {
    const { drafts } = githubIntake(
      "issue_comment",
      payload({ issue: { number: 7, pull_request: { url: "x" } } }),
      context,
    );
    expect(primaryThread(makeTrigger(drafts[0]!)!)?.threadId).toBe("pull/7");
  });

  it("reads a review comment from its pull request", () => {
    const { drafts } = githubIntake(
      "pull_request_review_comment",
      {
        repository: { full_name: "acme/demo" },
        pull_request: { number: 7 },
        comment: { id: 5, user: { login: "alice" }, created_at: "2026-01-01T00:00:00Z" },
      },
      context,
    );
    const trigger = makeTrigger(drafts[0]!)!;
    expect(trigger.kind).toBe("review");
    expect(primaryThread(trigger)?.threadId).toBe("pull/7");
  });

  it("turns a closed pull request into a close trigger", () => {
    const { drafts } = githubIntake(
      "pull_request",
      {
        repository: { full_name: "acme/demo" },
        action: "closed",
        pull_request: { number: 7, user: { login: "alice" }, closed_at: "2026-01-02T00:00:00Z" },
      },
      context,
    );
    expect(drafts[0]).toMatchObject({ kind: "close", externalId: "7:closed" });
  });

  it("ignores a pull request that was only opened", () => {
    const result = githubIntake(
      "pull_request",
      { repository: { full_name: "acme/demo" }, action: "opened", pull_request: { number: 7 } },
      context,
    );
    expect(result.dropped[0]!.code).toBe("incomplete");
  });

  it("turns a completed check run into a ci-change on the pull", () => {
    const { drafts } = githubIntake(
      "check_run",
      {
        repository: { full_name: "acme/demo" },
        check_run: {
          id: 31,
          status: "completed",
          conclusion: "failure",
          completed_at: "2026-01-03T00:00:00Z",
          pull_requests: [{ number: 7 }],
        },
      },
      context,
    );
    const trigger = makeTrigger(drafts[0]!)!;
    expect(trigger.kind).toBe("ci-change");
    expect(trigger.externalId).toBe("check_run:31:failure:2026-01-03T00:00:00Z");
    expect(primaryThread(trigger)?.threadId).toBe("pull/7");
  });

  it("ignores a check run that has not completed", () => {
    const result = githubIntake(
      "check_run",
      {
        repository: { full_name: "acme/demo" },
        check_run: { id: 31, status: "in_progress", pull_requests: [{ number: 7 }] },
      },
      context,
    );
    expect(result.dropped[0]!.code).toBe("incomplete");
  });
});

describe("github idempotence", () => {
  it("gives the same comment the same identity however often it arrives", () => {
    const first = githubIntake("issue_comment", payload(), context).drafts[0]!;
    const second = githubIntake("issue_comment", payload(), context).drafts[0]!;
    expect(makeTrigger(first)!.id).toBe(makeTrigger(second)!.id);
  });

  it("gives a different comment a different identity", () => {
    const a = githubIntake("issue_comment", payload({ comment: { id: 1, user: { login: "a" }, created_at: "x" } }), context);
    const b = githubIntake("issue_comment", payload({ comment: { id: 2, user: { login: "a" }, created_at: "x" } }), context);
    expect(makeTrigger(a.drafts[0]!)!.id).not.toBe(makeTrigger(b.drafts[0]!)!.id);
  });

  it("names one conclusion of one check run, so a rerun is a new event", () => {
    const run = (id: number, conclusion: string, at: string) => ({
      repository: { full_name: "acme/demo" },
      check_run: { id, status: "completed", conclusion, completed_at: at, pull_requests: [{ number: 7 }] },
    });
    const same = githubIntake("check_run", run(31, "failure", "t1"), context).drafts[0]!;
    const rerun = githubIntake("check_run", run(31, "success", "t2"), context).drafts[0]!;
    expect(same.externalId).not.toBe(rerun.externalId);
  });
});
