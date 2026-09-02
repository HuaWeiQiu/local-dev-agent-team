import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import { InquiryCoordinator } from "../src/inquiry/coordinator.js";
import { RunStateStore } from "../src/state/store.js";
import type { RunState } from "../src/state/types.js";

describe("InquiryCoordinator isolation", () => {
  it("answers a side-session question without mutating the run state", async () => {
    const fixture = await createFixture();
    const stateBefore = await readFile(fixture.statePath, "utf8");
    const runner = {
      answer: vi.fn(async ({ question }: { question: string }) => ({
        answer: `已回答：${question}`,
        keyPoints: ["关键点 1"],
        profileName: "fake",
        durationMs: 1,
      })),
    };
    const coordinator = new InquiryCoordinator(fixture.loaded, fixture.store, runner);

    const created = await coordinator.ask(fixture.run.id, "现在做到哪一步了？", "implementing");
    expect(created.status).toBe("running");
    await waitFor(async () => (await coordinator.get(fixture.run.id, created.id)).status === "completed");

    const answered = await coordinator.get(fixture.run.id, created.id);
    expect(answered.answer).toBe("已回答：现在做到哪一步了？");
    expect(answered.keyPoints).toEqual(["关键点 1"]);
    expect(runner.answer).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: fixture.run.id,
        stage: "implementing",
        question: "现在做到哪一步了？",
      }),
    );
    // The run's state.json stayed byte-for-byte identical.
    expect(await readFile(fixture.statePath, "utf8")).toBe(stateBefore);
    await coordinator.close();
  });

  it("deletes a single inquiry without touching others or the run", async () => {
    const fixture = await createFixture();
    const coordinator = new InquiryCoordinator(fixture.loaded, fixture.store, {
      answer: async ({ question }) => ({
        answer: `答：${question}`,
        keyPoints: [],
        profileName: "fake",
        durationMs: 1,
      }),
    });

    const first = await coordinator.ask(fixture.run.id, "问题一");
    await waitFor(async () => (await coordinator.get(fixture.run.id, first.id)).status === "completed");
    const second = await coordinator.ask(fixture.run.id, "问题二");
    await waitFor(async () =>
      (await coordinator.list(fixture.run.id)).filter((item) => item.status === "running").length === 0,
    );

    await coordinator.delete(fixture.run.id, first.id);
    const remaining = await coordinator.list(fixture.run.id);
    expect(remaining.map((item) => item.id)).toEqual([second.id]);
    expect((await fixture.store.load(fixture.run.id)).status).toBe("awaiting-human");
    await coordinator.close();
  });

  it("rejects a second in-flight inquiry for the same run", async () => {
    const fixture = await createFixture();
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new InquiryCoordinator(fixture.loaded, fixture.store, {
      answer: async ({ question }) => {
        await blocker;
        return { answer: question, keyPoints: [], profileName: "fake", durationMs: 1 };
      },
    });

    await coordinator.ask(fixture.run.id, "问题一");
    await expect(coordinator.ask(fixture.run.id, "问题二")).rejects.toThrow("in-flight");
    release();
    await waitFor(async () =>
      (await coordinator.list(fixture.run.id)).filter((item) => item.status === "running").length === 0,
    );
    await coordinator.close();
  });
});

async function createFixture(): Promise<{
  root: string;
  loaded: { root: string; path: string; config: ReturnType<typeof createDefaultConfig> };
  store: RunStateStore;
  run: RunState;
  statePath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-inquiry-"));
  const loaded = {
    root,
    path: path.join(root, "agent-team.yaml"),
    config: createDefaultConfig("inquiry-fixture"),
  };
  const store = new RunStateStore(path.join(root, ".agent-team", "runs"));
  const now = new Date().toISOString();
  const run: RunState = {
    id: "inquiry-run",
    goal: "Test inquiry",
    root,
    configPath: loaded.path,
    baseBranch: "main",
    baseCommit: "abc123",
    integrationBranch: "agent-team/inquiry-run/integration",
    integrationWorktree: path.join(root, ".agent-team", "worktrees", "inquiry-run", "integration"),
    status: "awaiting-human",
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
    history: [{ at: now, status: "awaiting-human", message: "等待人工" }],
  };
  await store.save(run);
  return {
    root,
    loaded,
    store,
    run,
    statePath: path.join(root, ".agent-team", "runs", "inquiry-run", "state.json"),
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}
