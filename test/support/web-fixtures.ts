import type { RunEvent, RunState } from "../../web/src/types.js";

export function runEvent(sequence: number, type: string, payload: unknown): RunEvent {
  return {
    sequence,
    id: `event-${sequence}`,
    schemaVersion: 1,
    runId: "run-fixture",
    type,
    occurredAt: `2026-08-11T18:00:${String(10 + sequence).padStart(2, "0")}.000Z`,
    payload,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
  };
}

export function runState(overrides: Record<string, unknown> = {}): RunState {
  return {
    id: "run-fixture",
    goal: "实现登录页",
    status: "implementing",
    strategy: {
      name: "default",
      maxParallel: 2,
      maxReworkAttempts: 1,
      executionTimeoutSeconds: 600,
      maxAgentInvocations: 64,
      maxProcessOutputBytes: 1,
      maxArtifactBytes: 1,
      roleProfiles: {},
      approvalGates: [],
      approvalTimeoutSeconds: 60,
    },
    profileOverrides: {},
    createdAt: "2026-08-11T18:00:00.000Z",
    updatedAt: "2026-08-11T18:00:00.000Z",
    tasks: [],
    history: [{ at: "2026-08-11T18:00:00.000Z", status: "created", message: "运行已创建" }],
    ...overrides,
  } as unknown as RunState;
}
