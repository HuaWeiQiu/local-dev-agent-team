import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubPublisher } from "../src/github/publish.js";
import { RunStateStore } from "../src/state/store.js";
import { OutboxStore } from "../src/authority/outbox-store.js";
import { markSent, messageId, receiptFor } from "../src/authority/outbox.js";
import type { LoadedConfig } from "../src/config/load.js";
import type { RunState } from "../src/state/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

function loaded(patch: Record<string, unknown> = {}): LoadedConfig {
  return {
    root: "/tmp",
    path: "/tmp/agent-team.yaml",
    config: {
      github: {
        enabled: true,
        remote: "origin",
        draftPullRequest: false,
        checkTimeoutSeconds: 1,
        ...(patch.github as object),
      },
      project: { name: "demo", stateDirectory: ".agent-team", defaultBranch: "main" },
    },
  } as unknown as LoadedConfig;
}

function state(patch: Partial<RunState> = {}): RunState {
  return {
    id: "run-1",
    goal: "Ship the thing",
    status: "ready-to-merge",
    root: "/tmp",
    configPath: "agent-team.yaml",
    baseBranch: "main",
    baseCommit: "abc",
    integrationBranch: "agent-team/integration",
    integrationWorktree: "/tmp/wt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    profileOverrides: {},
    strategy: { name: "balanced" } as never,
    tasks: [
      { task: { id: "T1", title: "Do it" }, status: "merged", attempts: 1, profile: null } as never,
    ],
    approvals: [{ gate: "final", status: "approved" } as never],
    history: [],
    ...patch,
  } as unknown as RunState;
}

async function store(): Promise<RunStateStore> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-publish-"));
  roots.push(root);
  return new RunStateStore(path.join(root, "runs"));
}

function client(patch: Record<string, unknown> = {}) {
  return {
    authStatus: vi.fn(async () => ({ authenticated: true })),
    repository: vi.fn(async () => ({ nameWithOwner: "acme/demo" })),
    findPullRequest: vi.fn(async () => undefined),
    createPullRequest: vi.fn(async () => ({ url: "https://github.com/acme/demo/pull/1", number: 1 })),
    ...patch,
  } as never;
}

const noPush = async () => undefined;

describe("publish", () => {
  it("creates a pull request once the branch is pushed", async () => {
    const s = await store();
    const fake = client();
    const publisher = new GithubPublisher(loaded(), s, fake, noPush);
    const run = state();
    await publisher.publish(run);
    expect(run).toMatchObject({
      status: "waiting-ci",
      repository: "acme/demo",
      pullRequestNumber: 1,
    });
    expect((fake as unknown as { createPullRequest: ReturnType<typeof vi.fn> }).createPullRequest).toHaveBeenCalled();
  });

  it("reuses a pull request that already exists", async () => {
    const s = await store();
    const fake = client({
      findPullRequest: vi.fn(async () => ({ url: "https://github.com/acme/demo/pull/9", number: 9 })),
    });
    const publisher = new GithubPublisher(loaded(), s, fake, noPush);
    const run = state();
    await publisher.publish(run);
    expect(run.pullRequestNumber).toBe(9);
    expect((fake as unknown as { createPullRequest: ReturnType<typeof vi.fn> }).createPullRequest).not.toHaveBeenCalled();
  });

  it("refuses without GitHub, without a final approval, or from a wrong status", async () => {
    const s = await store();
    const disabled = new GithubPublisher(loaded({ github: { enabled: false } }), s, client(), noPush);
    await expect(disabled.publish(state())).rejects.toBeTruthy();

    const unapproved = new GithubPublisher(loaded(), s, client(), noPush);
    await expect(unapproved.publish(state({ approvals: [] }))).rejects.toThrow(/final human approval/);

    await expect(unapproved.publish(state({ status: "implementing" }))).rejects.toThrow(
      /cannot be published from status/,
    );
  });

  it("records the failure and falls back to a publishable status", async () => {
    const s = await store();
    const failing = client({
      authStatus: vi.fn(async () => {
        throw new Error("gh is not logged in");
      }),
    });
    const publisher = new GithubPublisher(loaded(), s, failing, noPush);
    const run = state();
    await expect(publisher.publish(run)).rejects.toBeTruthy();
    expect(run).toMatchObject({ status: "ready-to-merge" });
    expect(run.error).toBeTruthy();
  });
});

describe("refreshChecks", () => {
  const published = () => state({ repository: "acme/demo", pullRequestUrl: "https://github.com/acme/demo/pull/1" });

  it("settles on the checks' verdict", async () => {
    const s = await store();
    const passing = new GithubPublisher(
      loaded(),
      s,
      client({ checks: vi.fn(async () => [{ name: "ci", state: "SUCCESS", bucket: "pass" }]) }),
      noPush,
    );
    const run = published();
    await expect(passing.refreshChecks(run, false)).resolves.toHaveLength(1);
    expect(run.status).toBe("ready-to-merge");
  });

  it("reports a failing check as ci-failed", async () => {
    const s = await store();
    const failing = new GithubPublisher(
      loaded(),
      s,
      client({ checks: vi.fn(async () => [{ name: "ci", state: "FAILURE", bucket: "fail" }]) }),
      noPush,
    );
    const run = published();
    await failing.refreshChecks(run, false);
    expect(run.status).toBe("ci-failed");
  });

  it("keeps waiting while a check is pending", async () => {
    const s = await store();
    const pending = new GithubPublisher(
      loaded(),
      s,
      client({ checks: vi.fn(async () => [{ name: "ci", state: "IN_PROGRESS", bucket: "pending" }]) }),
      noPush,
    );
    const run = published();
    await pending.refreshChecks(run, false);
    expect(run.status).toBe("waiting-ci");
  });

  it("refuses an unpublished run", async () => {
    const s = await store();
    const publisher = new GithubPublisher(loaded(), s, client(), noPush);
    await expect(publisher.refreshChecks(state(), false)).rejects.toThrow(/not been published/);
  });
});

describe("markCompletedIfMerged", () => {
  const published = () => state({ repository: "acme/demo", pullRequestUrl: "https://github.com/acme/demo/pull/1" });

  it("completes a merged pull request", async () => {
    const s = await store();
    const merged = new GithubPublisher(
      loaded(),
      s,
      client({ pullRequest: vi.fn(async () => ({ mergedAt: "2026-01-02T00:00:00.000Z" })) }),
      noPush,
    );
    const run = published();
    await expect(merged.markCompletedIfMerged(run)).resolves.toBe(true);
    expect(run.status).toBe("completed");
  });

  it("leaves an unmerged pull request alone", async () => {
    const s = await store();
    const open = new GithubPublisher(
      loaded(),
      s,
      client({ pullRequest: vi.fn(async () => ({ mergedAt: undefined })) }),
      noPush,
    );
    const run = published();
    await expect(open.markCompletedIfMerged(run)).resolves.toBe(false);
  });

  it("refuses an unpublished run", async () => {
    const s = await store();
    const publisher = new GithubPublisher(loaded(), s, client(), noPush);
    await expect(publisher.markCompletedIfMerged(state())).rejects.toThrow(/not been published/);
  });
});

describe("publication receipts", () => {
  async function withOutbox() {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-outbox-"));
    roots.push(root);
    const s = new RunStateStore(path.join(root, "runs"));
    const outbox = new OutboxStore(path.join(root, "outbox.json"));
    return { store: s, outbox, root };
  }

  const receiptInput = {
    purpose: "result" as const,
    subjectId: "run-1",
    channel: { sourceKind: "github", sourceInstanceId: "origin", threadId: "agent-team/integration" },
    body: "",
    at: "2026-01-01T00:00:00.000Z",
  };

  it("records a receipt once the pull request exists", async () => {
    const { store: s, outbox } = await withOutbox();
    const publisher = new GithubPublisher(loaded(), s, client(), noPush, outbox);
    await publisher.publish(state());
    const receipt = await outbox.get(messageId(receiptInput));
    expect(receipt).toMatchObject({
      state: "sent",
      body: "https://github.com/acme/demo/pull/1",
      attempts: 1,
    });
  });

  it("answers from a receipt that already says sent, without asking GitHub", async () => {
    const { store: s, outbox } = await withOutbox();
    const fake = client();
    await outbox.save(
      markSent({ ...receiptFor(receiptInput), body: "https://github.com/acme/demo/pull/9" }, "t"),
    );
    const run = state();
    await new GithubPublisher(loaded(), s, fake, noPush, outbox).publish(run);
    expect(run.pullRequestUrl).toBe("https://github.com/acme/demo/pull/9");
    const spies = fake as unknown as { createPullRequest: ReturnType<typeof vi.fn>; findPullRequest: ReturnType<typeof vi.fn> };
    expect(spies.createPullRequest).not.toHaveBeenCalled();
    expect(spies.findPullRequest).not.toHaveBeenCalled();
  });

  it("records why a publication failed, and lets a retry try again", async () => {
    const { store: s, outbox } = await withOutbox();
    const failing = client({
      authStatus: vi.fn(async () => {
        throw new Error("gh is not logged in");
      }),
    });
    await expect(new GithubPublisher(loaded(), s, failing, noPush, outbox).publish(state())).rejects.toBeTruthy();
    const failed = await outbox.get(messageId(receiptInput));
    expect(failed).toMatchObject({ state: "failed", attempts: 1 });
    // The failure is classified before it is recorded; the receipt keeps the copy
    // the operator will see, which is the classified one.
    expect(failed!.lastError).toBeTruthy();

    const working = client();
    await new GithubPublisher(loaded(), s, working, noPush, outbox).publish(state());
    const sent = await outbox.get(messageId(receiptInput));
    expect(sent).toMatchObject({ state: "sent", attempts: 2 });
  });

  it("keeps today's behaviour without an outbox", async () => {
    const { store: s } = await withOutbox();
    await expect(new GithubPublisher(loaded(), s, client(), noPush).publish(state())).resolves.toMatchObject({
      status: "waiting-ci",
    });
  });
});
