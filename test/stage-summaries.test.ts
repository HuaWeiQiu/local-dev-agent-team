import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RunStateStore } from "../src/state/store.js";
import type { RunState } from "../src/state/types.js";

describe("stage summaries", () => {
  it("appends one concise summary per stage transition and bounds highlights", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-stage-summaries-"));
    const store = new RunStateStore(path.join(root, "runs"));
    const state = fakeRun(root);

    await store.save(state);
    await store.transition(state, "orchestrating", "总控正在分析目标");
    await store.transition(state, "architecting", "架构正在拆分任务 DAG（plan）");
    await store.transition(state, "planned", "架构产出 3 个任务", {
      highlights: ["任务 T1", "任务 T2", "任务 T3", "任务 T4", "任务 T5", "任务 T5"],
    });
    // Same-stage message updates the history but not the summary list.
    await store.transition(state, "planned", "计划补充说明");

    expect(state.stageSummaries?.map((summary) => summary.stage)).toEqual([
      "orchestrating",
      "architecting",
      "planned",
    ]);
    expect(state.stageSummaries?.at(-1)?.title).toBe("已规划");
    expect(state.stageSummaries?.at(-1)?.summary).toBe("架构产出 3 个任务");
    expect(state.stageSummaries?.at(-1)?.highlights).toEqual(["任务 T1", "任务 T2", "任务 T3", "任务 T4"]);

    const persisted = await store.load(state.id);
    expect(persisted.stageSummaries).toEqual(state.stageSummaries);
  });

  it("keeps old state documents without stageSummaries loadable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-legacy-summary-"));
    const store = new RunStateStore(path.join(root, "runs"));
    const state = fakeRun(root);
    await store.save(state);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = JSON.parse(await readFile(
      path.join(root, "runs", state.id, "state.json"),
      "utf8",
    )) as Record<string, unknown>;
    delete raw.stageSummaries;
    await writeFile(
      path.join(root, "runs", state.id, "state.json"),
      `${JSON.stringify(raw)}\n`,
    );
    const loaded = await store.load(state.id);
    expect(loaded.stageSummaries).toBeUndefined();
  });
});

function fakeRun(root: string): RunState {
  const now = new Date().toISOString();
  return {
    id: "summary-run",
    goal: "Test stage summaries",
    root,
    configPath: path.join(root, "agent-team.yaml"),
    baseBranch: "main",
    baseCommit: "abc123",
    integrationBranch: "agent-team/summary-run/integration",
    integrationWorktree: path.join(root, ".agent-team", "worktrees", "summary-run", "integration"),
    status: "created",
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
    history: [{ at: now, status: "created", message: "Run created" }],
  };
}
