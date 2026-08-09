import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { maxRunHistoryEntries, RunStateStore } from "../src/state/store.js";
import type { RunState } from "../src/state/types.js";

describe("run state store", () => {
  it("keeps only the most recent history entries when saving", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-state-"));
    const store = new RunStateStore(path.join(root, "runs"));
    const state = fakeState("history-run");
    for (let index = 0; index < maxRunHistoryEntries + 100; index += 1) {
      state.history.push({
        at: new Date().toISOString(),
        status: "implementing",
        message: `entry-${index}`,
      });
    }

    await store.save(state);
    const loaded = await store.load(state.id);
    expect(loaded.history).toHaveLength(maxRunHistoryEntries);
    expect(loaded.history[0]!.message).toBe("entry-100");
    expect(loaded.history.at(-1)!.message).toBe(`entry-${maxRunHistoryEntries + 99}`);
  });
});

function fakeState(id: string): RunState {
  const now = new Date().toISOString();
  return {
    id,
    goal: "Bound history",
    root: "/tmp",
    configPath: "/tmp/agent-team.yaml",
    baseBranch: "main",
    baseCommit: "abc",
    integrationBranch: `agent-team/${id}/integration`,
    integrationWorktree: `/tmp/${id}`,
    status: "implementing",
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
