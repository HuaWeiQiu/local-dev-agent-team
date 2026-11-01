import type { RunEvent } from "../events/types.js";

export interface UsageLine {
  invocations: number;
  failures: number;
  durationMs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** False when no invocation reported a cost, so zero is "unknown", not "free". */
  costReported: boolean;
}

export interface RunUsageBreakdown {
  total: UsageLine;
  byRole: Array<UsageLine & { role: string }>;
  byTask: Array<UsageLine & { taskId: string }>;
  byProfile: Array<UsageLine & { profile: string; model: string }>;
  /** Invocations that did not belong to any task (planning, advice, final decision). */
  unattributed: UsageLine;
}

const TASK_KEY = /(?:^|\/)tasks\/([^/]+)\/attempt-\d+\//;

export function taskIdFromArtifactKey(artifactKey: string | undefined): string | undefined {
  return artifactKey ? TASK_KEY.exec(artifactKey)?.[1] : undefined;
}

function emptyLine(): UsageLine {
  return {
    invocations: 0,
    failures: 0,
    durationMs: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    costReported: false,
  };
}

interface CompletedPayload {
  role?: string;
  profile?: string;
  model?: string;
  artifactKey?: string;
  durationMs?: number;
  success?: boolean;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reportedCostUsd?: number;
  };
}

/** Stands in for a payload without a usage block, so the field reads stay plain. */
const NO_USAGE: NonNullable<CompletedPayload["usage"]> = {};

/** One invocation, reduced to the numbers the ledger accumulates. */
interface UsageDelta {
  failure: boolean;
  durationMs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reportedCostUsd: number | undefined;
}

/** Does this event contribute to usage at all? */
function countsForUsage(event: RunEvent): boolean {
  return event.type === "agent.invocation.completed";
}

function orZero(value: number | undefined): number {
  return value ?? 0;
}

/** Reads one event's numbers out of its payload, defaulting what is absent. */
function readDelta(payload: CompletedPayload): UsageDelta {
  const usage = payload.usage ?? NO_USAGE;
  return {
    failure: payload.success === false,
    durationMs: orZero(payload.durationMs),
    inputTokens: orZero(usage.inputTokens),
    cachedInputTokens: orZero(usage.cachedInputTokens),
    outputTokens: orZero(usage.outputTokens),
    reportedCostUsd: usage.reportedCostUsd,
  };
}

/** Adds one delta to a line. Only a reported cost moves the "known cost" flag. */
function accumulate(line: UsageLine, delta: UsageDelta): void {
  line.invocations += 1;
  if (delta.failure) line.failures += 1;
  line.durationMs += delta.durationMs;
  line.inputTokens += delta.inputTokens;
  line.cachedInputTokens += delta.cachedInputTokens;
  line.outputTokens += delta.outputTokens;
  if (delta.reportedCostUsd !== undefined) {
    line.costUsd += delta.reportedCostUsd;
    line.costReported = true;
  }
}

/** The line stored under a key, created on first sight. */
function lineAt<T extends UsageLine>(lines: Map<string, T>, key: string, create: () => T): T {
  const existing = lines.get(key);
  if (existing) return existing;
  const created = create();
  lines.set(key, created);
  return created;
}

function countRole(
  roles: Map<string, UsageLine>,
  payload: CompletedPayload,
  delta: UsageDelta,
): void {
  accumulate(lineAt(roles, payload.role ?? "unknown", emptyLine), delta);
}

function countTask(
  tasks: Map<string, UsageLine>,
  unattributed: UsageLine,
  payload: CompletedPayload,
  delta: UsageDelta,
): void {
  const taskId = taskIdFromArtifactKey(payload.artifactKey);
  if (taskId) accumulate(lineAt(tasks, taskId, emptyLine), delta);
  else accumulate(unattributed, delta);
}

function countProfile(
  profiles: Map<string, UsageLine & { profile: string; model: string }>,
  payload: CompletedPayload,
  delta: UsageDelta,
): void {
  const profile = payload.profile ?? "unknown";
  const model = payload.model ?? "";
  const key = `${profile}\u0000${model}`;
  const create = (): UsageLine & { profile: string; model: string } => ({
    ...emptyLine(),
    profile,
    model,
  });
  accumulate(lineAt(profiles, key, create), delta);
}

function byCost(left: UsageLine, right: UsageLine): number {
  return (
    right.costUsd - left.costUsd ||
    right.inputTokens + right.outputTokens - (left.inputTokens + left.outputTokens) ||
    right.durationMs - left.durationMs
  );
}

/** Rolls the ledger's completed invocations up by role, task and profile. */
export function foldRunUsage(events: readonly RunEvent[]): RunUsageBreakdown {
  const total = emptyLine();
  const unattributed = emptyLine();
  const roles = new Map<string, UsageLine>();
  const tasks = new Map<string, UsageLine>();
  const profiles = new Map<string, UsageLine & { profile: string; model: string }>();

  for (const event of events) {
    if (!countsForUsage(event)) continue;
    const payload = event.payload as CompletedPayload;
    const delta = readDelta(payload);
    accumulate(total, delta);
    countRole(roles, payload, delta);
    countTask(tasks, unattributed, payload, delta);
    countProfile(profiles, payload, delta);
  }

  return {
    total,
    byRole: [...roles].map(([role, line]) => ({ role, ...line })).sort(byCost),
    byTask: [...tasks].map(([taskId, line]) => ({ taskId, ...line })).sort(byCost),
    byProfile: [...profiles.values()].sort(byCost),
    unattributed,
  };
}
