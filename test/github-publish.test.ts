import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import type { LoadedConfig } from "../src/config/load.js";
import { SqliteEventStore } from "../src/events/store.js";
import { GithubClient } from "../src/github/client.js";
import { GithubPublisher } from "../src/github/publish.js";
import { RunStateStore } from "../src/state/store.js";
import type { RunState } from "../src/state/types.js";

describe("GithubPublisher approval boundary", () => {
  it("rejects publication until the latest final request is approved", async () => {
    const fixture = await createFixture();
    const state = fakeRun("awaiting-human");
    state.approvals = [
      {
        id: "approval-1",
        gate: "final",
        status: "pending",
        summary: "Review integration result",
        checkpointId: "checkpoint-1",
        requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ];

    await expect(fixture.publisher.publish(state)).rejects.toThrow(
      "requires final human approval before publication",
    );
    expect(state.status).toBe("awaiting-human");
    fixture.events.close();
  });

  it("rejects an approved run from a non-publishable status", async () => {
    const fixture = await createFixture();
    const state = fakeRun("blocked");
    state.approvals = [approvedFinalApproval()];

    await expect(fixture.publisher.publish(state)).rejects.toThrow(
      "cannot be published from status 'blocked'",
    );
    fixture.events.close();
  });

  it("falls back to ready-to-merge and records the error when publication fails", async () => {
    const fixture = await createFixture();
    const state = fakeRun("ready-to-merge");
    state.approvals = [approvedFinalApproval()];
    const publisher = new GithubPublisher(fixture.loaded, fixture.store, {
      authStatus: async () => {
        throw new Error("gh auth failed");
      },
    } as unknown as GithubClient);

    await expect(publisher.publish(state)).rejects.toThrow("gh auth failed");
    expect(state.status).toBe("ready-to-merge");
    expect(state.error).toContain("gh auth failed");
    // The fallback is persisted, so the run can be published again or cleaned up.
    const persisted = await fixture.store.load(state.id);
    expect(persisted.status).toBe("ready-to-merge");
    expect(persisted.error).toContain("gh auth failed");
    fixture.events.close();
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-publisher-"));
  const loaded: LoadedConfig = {
    root,
    path: path.join(root, "agent-team.yaml"),
    config: createDefaultConfig("publisher-fixture"),
  };
  const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
  const store = new RunStateStore(path.join(root, ".agent-team", "runs"), events);
  return { events, loaded, store, publisher: new GithubPublisher(loaded, store) };
}

function approvedFinalApproval(): NonNullable<RunState["approvals"]>[number] {
  return {
    id: "approval-1",
    gate: "final",
    status: "approved",
    summary: "Review integration result",
    checkpointId: "checkpoint-1",
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    response: {
      decision: "approved",
      actor: "release-owner",
      reason: "Diff reviewed",
      respondedAt: new Date().toISOString(),
    },
  };
}

function fakeRun(status: RunState["status"]): RunState {
  const now = new Date().toISOString();
  return {
    id: "publish-run",
    goal: "Publish guarded result",
    root: "/tmp/project",
    configPath: "/tmp/project/agent-team.yaml",
    baseBranch: "main",
    baseCommit: "abc",
    integrationBranch: "agent-team/publish-run/integration",
    integrationWorktree: "/tmp/project/integration",
    status,
    createdAt: now,
    updatedAt: now,
    profileOverrides: {},
    strategy: {
      name: "balanced",
      maxParallel: 2,
      maxReworkAttempts: 2,
      executionTimeoutSeconds: 14_400,
      maxAgentInvocations: 64,
      maxProcessOutputBytes: 1_048_576,
      maxArtifactBytes: 1_073_741_824,
      roleProfiles: {},
      approvalGates: ["final"],
      approvalTimeoutSeconds: 86_400,
    },
    tasks: [],
    history: [],
  };
}
