import type {
  AgentActivityParser,
  AgentActivitySnapshot,
  ChildAgentState,
  ChildAgentStatus,
} from "./types.js";

const maxBufferedCharacters = 1024 * 1024;
const maxTrackedAgents = 64;

export class CodexActivityParser implements AgentActivityParser {
  private buffer = "";
  private discardingOversizedLine = false;
  private readonly agents = new Map<string, ChildAgentState>();
  private lastSnapshot = "";

  push(chunk: string): AgentActivitySnapshot[] {
    if (!chunk) return [];
    const lines: string[] = [];
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf("\n", cursor);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.slice(cursor, end);

      if (this.discardingOversizedLine) {
        if (newline === -1) break;
        this.discardingOversizedLine = false;
      } else if (this.buffer.length + segment.length > maxBufferedCharacters) {
        this.buffer = "";
        if (newline === -1) this.discardingOversizedLine = true;
      } else {
        this.buffer += segment;
        if (newline === -1) break;
        lines.push(this.buffer);
        this.buffer = "";
      }

      cursor = end + 1;
    }
    return this.consume(lines);
  }

  finish(): AgentActivitySnapshot[] {
    const snapshots = !this.discardingOversizedLine && this.buffer
      ? this.consume([this.buffer])
      : [];
    this.buffer = "";
    this.discardingOversizedLine = false;
    let changed = false;
    for (const [threadId, agent] of this.agents) {
      if (agent.status === "pending" || agent.status === "running") {
        this.agents.set(threadId, { ...agent, status: "interrupted" });
        changed = true;
      }
    }
    const finalSnapshot = changed ? this.snapshot() : undefined;
    return finalSnapshot ? [...snapshots, finalSnapshot] : snapshots;
  }

  private consume(lines: string[]): AgentActivitySnapshot[] {
    const snapshots: AgentActivitySnapshot[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: Record<string, unknown>;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!isRecord(parsed)) continue;
        event = parsed;
      } catch {
        continue;
      }
      const item = eventItem(event);
      if (!item || !this.updateFromItem(item, eventPhase(event))) continue;
      const snapshot = this.snapshot();
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots;
  }

  private updateFromItem(item: Record<string, unknown>, phase: EventPhase): boolean {
    const type = normalizedToken(stringField(item, "type"));
    if (type === "collabtoolcall" || type === "collabagenttoolcall") {
      return this.updateFromCollabCall(item, phase);
    }
    if (type === "subagentactivity") {
      return this.updateFromSubagentActivity(item);
    }
    return false;
  }

  private updateFromCollabCall(item: Record<string, unknown>, phase: EventPhase): boolean {
    const tool = normalizedToken(stringField(item, "tool"));
    const callStatus = normalizedToken(stringField(item, "status"));
    const states = recordField(item, "agents_states", "agentsStates");
    const receiverIds = stringArrayField(item, "receiver_thread_ids", "receiverThreadIds");
    const receivers = receiverAgentMetadata(item);
    const ids = new Set([...receiverIds, ...Object.keys(states ?? {}), ...receivers.keys()]);
    let changed = false;

    for (const threadId of ids) {
      const state = isRecord(states?.[threadId]) ? states[threadId] : undefined;
      const existing = this.agents.get(threadId);
      const metadata = receivers.get(threadId);
      const status = statusFromCollabState(state?.status)
        ?? statusFromTool(tool, callStatus, phase)
        ?? existing?.status
        ?? "unknown";
      const agentPath = metadata?.path ?? existing?.path;
      const model = metadata?.model
        ?? boundedString(stringField(item, "model"), 128)
        ?? existing?.model;
      const reasoning = metadata?.reasoning
        ?? boundedString(stringField(item, "reasoning_effort", "reasoningEffort"), 32)
        ?? existing?.reasoning;
      changed = this.upsert({
        threadId,
        status,
        ...(agentPath ? { path: agentPath } : {}),
        ...(model ? { model } : {}),
        ...(reasoning ? { reasoning } : {}),
      }) || changed;
    }
    return changed;
  }

  private updateFromSubagentActivity(item: Record<string, unknown>): boolean {
    const threadId = stringField(item, "agent_thread_id", "agentThreadId");
    if (!threadId) return false;
    const existing = this.agents.get(threadId);
    const kind = normalizedToken(stringField(item, "kind"));
    const status: ChildAgentStatus = kind === "interrupted"
      ? "interrupted"
      : existing?.status ?? "running";
    const agentPath = boundedString(stringField(item, "agent_path", "agentPath"), 256);
    const resolvedPath = agentPath ?? existing?.path;
    return this.upsert({
      threadId,
      status,
      ...(resolvedPath ? { path: resolvedPath } : {}),
      ...(existing?.model ? { model: existing.model } : {}),
      ...(existing?.reasoning ? { reasoning: existing.reasoning } : {}),
    });
  }

  private upsert(agent: ChildAgentState): boolean {
    if (!validThreadId(agent.threadId)) return false;
    if (!this.agents.has(agent.threadId) && this.agents.size >= maxTrackedAgents) return false;
    const previous = this.agents.get(agent.threadId);
    if (previous && JSON.stringify(previous) === JSON.stringify(agent)) return false;
    this.agents.set(agent.threadId, agent);
    return true;
  }

  private snapshot(): AgentActivitySnapshot | undefined {
    const agents = [...this.agents.values()].sort((left, right) =>
      left.threadId.localeCompare(right.threadId),
    );
    const serialized = JSON.stringify(agents);
    if (serialized === this.lastSnapshot) return undefined;
    this.lastSnapshot = serialized;
    return { type: "child-agents", agents };
  }
}

type EventPhase = "started" | "completed" | "unknown";

function eventPhase(event: Record<string, unknown>): EventPhase {
  const type = normalizedToken(stringField(event, "type"));
  if (type === "itemstarted") return "started";
  if (type === "itemcompleted") return "completed";
  return "unknown";
}

function eventItem(event: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(event.item)) return event.item;
  if (isRecord(event.params) && isRecord(event.params.item)) return event.params.item;
  return undefined;
}

function statusFromTool(
  tool: string,
  callStatus: string,
  phase: EventPhase,
): ChildAgentStatus | undefined {
  if (callStatus === "failed") return "failed";
  if (tool === "closeagent" && (phase === "completed" || callStatus === "completed")) {
    return "shutdown";
  }
  if (tool === "spawnagent") {
    return phase === "started" || callStatus === "inprogress" ? "pending" : "running";
  }
  if (tool === "sendinput" || tool === "resumeagent") return "running";
  return undefined;
}

function statusFromCollabState(value: unknown): ChildAgentStatus | undefined {
  const status = normalizedToken(typeof value === "string" ? value : undefined);
  return {
    pendinginit: "pending",
    pending: "pending",
    running: "running",
    inprogress: "running",
    completed: "completed",
    interrupted: "interrupted",
    errored: "failed",
    failed: "failed",
    shutdown: "shutdown",
    notfound: "failed",
  }[status] as ChildAgentStatus | undefined;
}

interface ReceiverMetadata {
  path?: string;
  model?: string;
  reasoning?: string;
}

function receiverAgentMetadata(item: Record<string, unknown>): Map<string, ReceiverMetadata> {
  const result = new Map<string, ReceiverMetadata>();
  const raw = item.receiver_agents ?? item.receiverAgents;
  if (!Array.isArray(raw)) return result;
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const threadId = stringField(entry, "thread_id", "threadId", "agent_thread_id", "agentThreadId");
    if (!threadId) continue;
    const path = boundedString(stringField(entry, "agent_path", "agentPath", "path", "task_name", "taskName"), 256);
    const model = boundedString(stringField(entry, "model"), 128);
    const reasoning = boundedString(stringField(entry, "reasoning_effort", "reasoningEffort", "reasoning"), 32);
    result.set(threadId, {
      ...(path ? { path } : {}),
      ...(model ? { model } : {}),
      ...(reasoning ? { reasoning } : {}),
    });
  }
  return result;
}

function recordField(
  record: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> | undefined {
  for (const key of keys) {
    if (isRecord(record[key])) return record[key];
  }
  return undefined;
}

function stringArrayField(record: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key];
  }
  return undefined;
}

function boundedString(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function normalizedToken(value: string | undefined): string {
  return value?.replace(/[^A-Za-z0-9]/g, "").toLowerCase() ?? "";
}

function validThreadId(value: string): boolean {
  return value.length > 0 && value.length <= 200 && /^[A-Za-z0-9._:/-]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
