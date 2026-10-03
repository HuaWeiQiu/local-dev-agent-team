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

function add(line: UsageLine, payload: CompletedPayload): void {
  line.invocations += 1;
  if (payload.success === false) line.failures += 1;
  line.durationMs += payload.durationMs ?? 0;
  line.inputTokens += payload.usage?.inputTokens ?? 0;
  line.cachedInputTokens += payload.usage?.cachedInputTokens ?? 0;
  line.outputTokens += payload.usage?.outputTokens ?? 0;
  if (payload.usage?.reportedCostUsd !== undefined) {
    line.costUsd += payload.usage.reportedCostUsd;
    line.costReported = true;
  }
}

/** Rolls the ledger's completed invocations up by role, task and profile. */
export function foldRunUsage(events: readonly RunEvent[]): RunUsageBreakdown {
  const total = emptyLine();
  const unattributed = emptyLine();
  const roles = new Map<string, UsageLine>();
  const tasks = new Map<string, UsageLine>();
  const profiles = new Map<string, UsageLine & { profile: string; model: string }>();

  for (const event of events) {
    if (event.type !== "agent.invocation.completed") continue;
    const payload = event.payload as CompletedPayload;
    add(total, payload);

    const role = payload.role ?? "unknown";
    add(roles.get(role) ?? roles.set(role, emptyLine()).get(role)!, payload);

    const taskId = taskIdFromArtifactKey(payload.artifactKey);
    if (taskId) add(tasks.get(taskId) ?? tasks.set(taskId, emptyLine()).get(taskId)!, payload);
    else add(unattributed, payload);

    const profile = payload.profile ?? "unknown";
    const model = payload.model ?? "";
    const key = `${profile}\u0000${model}`;
    let line = profiles.get(key);
    if (!line) {
      line = { ...emptyLine(), profile, model };
      profiles.set(key, line);
    }
    add(line, payload);
  }

  const byCost = (left: UsageLine, right: UsageLine): number =>
    right.costUsd - left.costUsd ||
    right.inputTokens + right.outputTokens - (left.inputTokens + left.outputTokens) ||
    right.durationMs - left.durationMs;

  return {
    total,
    byRole: [...roles].map(([role, line]) => ({ role, ...line })).sort(byCost),
    byTask: [...tasks].map(([taskId, line]) => ({ taskId, ...line })).sort(byCost),
    byProfile: [...profiles.values()].sort(byCost),
    unattributed,
  };
}
