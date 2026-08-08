import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/events/store.js";
import { createExecutionDeadline, RunBudgetTracker } from "../src/observability/budget.js";
import { buildOtlpTraceExport } from "../src/observability/otlp.js";
import { RunStateStore } from "../src/state/store.js";
import type { RunState } from "../src/state/types.js";

describe("run observability", () => {
  it("enforces invocation and artifact budgets while recording reported usage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-budget-"));
    const events = new SqliteEventStore(path.join(root, "events.sqlite"));
    const store = new RunStateStore(path.join(root, "runs"), events);
    const state = fakeState();
    state.strategy.maxAgentInvocations = 1;
    const budget = new RunBudgetTracker(state, store);
    const observation = {
      runId: state.id,
      role: "worker",
      profile: "codex-worker",
      adapter: "codex",
      model: "inherit",
      permission: "workspace-write",
      externalTools: "deny",
      artifactKey: "tasks/api/worker",
    };
    const invocationId = await budget.beforeInvocation(observation);
    await budget.afterInvocation({
      ...observation,
      invocationId,
      durationMs: 20,
      result: {
        text: "done",
        usage: { inputTokens: 12, outputTokens: 4 },
        process: {
          command: "fixture",
          args: [],
          exitCode: 0,
          stdout: "done",
          stderr: "",
          durationMs: 15,
          timedOut: false,
          signal: null,
          stdoutBytes: 4,
          stderrBytes: 0,
        },
      },
    });

    expect(state.usage).toMatchObject({
      agentInvocations: 1,
      agentDurationMs: 15,
      processOutputBytes: 4,
      inputTokens: 12,
      outputTokens: 4,
    });
    expect(
      events.listAfter(0, state.id).find((event) => event.type === "agent.invocation.completed")
        ?.payload,
    ).toMatchObject({
      permission: "workspace-write",
      externalTools: "deny",
    });
    await expect(budget.beforeInvocation(observation)).rejects.toThrow(
      "Agent invocation budget of 1 exhausted",
    );

    state.strategy.maxArtifactBytes = 4;
    const artifactDirectory = store.artifactDirectory(state.id);
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(path.join(artifactDirectory, "oversized.log"), "12345");
    await expect(budget.beforeInvocation(observation)).rejects.toThrow(
      "Artifact budget of 4 bytes exceeded",
    );
    events.close();
  });

  it("exports retained events as OTLP JSON spans with stable correlation IDs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-otlp-"));
    const events = new SqliteEventStore(path.join(root, "events.sqlite"));
    events.emit("run-observed", "agent.invocation.completed", {
      role: "worker",
      adapter: "codex",
      model: "inherit",
      durationMs: 25.5,
      success: true,
      usage: { inputTokens: 8, outputTokens: 3 },
    });
    const stored = events.listAfter(0, "run-observed");
    const exported = buildOtlpTraceExport(stored, "fixture") as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>;
    };
    const span = exported.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;

    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.name).toBe("invoke_agent");
    expect(span.startTimeUnixNano).toMatch(/^\d+$/);
    expect(span.endTimeUnixNano).toMatch(/^\d+$/);
    events.close();
  });

  it("aborts an execution segment when its strategy deadline expires", async () => {
    const deadline = createExecutionDeadline(0.001);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(() => deadline.signal.throwIfAborted()).toThrow(
      "Execution timeout of 0.001 seconds exceeded",
    );
    deadline.dispose();
  });
});

function fakeState(): RunState {
  const now = new Date().toISOString();
  return {
    id: "budget-run",
    goal: "Observe budget",
    root: "/tmp",
    configPath: "/tmp/agent-team.yaml",
    baseBranch: "main",
    baseCommit: "abc",
    integrationBranch: "agent-team/budget/integration",
    integrationWorktree: "/tmp/integration",
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
