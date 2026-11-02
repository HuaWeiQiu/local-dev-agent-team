import type { RunEvent } from "../events/types.js";
import type { FlowNodeStatus } from "./executor.js";
import type { FlowSelection, RunNodeKind, TriageEvent } from "./types.js";

export interface FlowNodeProgress {
  nodeId: RunNodeKind;
  status: FlowNodeStatus;
  /** How many times the node began (resumes re-enter nodes). */
  attempts: number;
  startedAt?: string;
  endedAt?: string;
  reason?: string;
}

export interface FlowProgress {
  selection?: FlowSelection;
  nodes: FlowNodeProgress[];
  /** Retry-or-consult decisions taken between rework attempts, in order. */
  triage?: TriageEvent[];
  /** The node a run is working in, or parked at, right now. */
  current?: RunNodeKind;
}

/**
 * Rebuilds flow progress from the append-only ledger. The ledger is the only
 * input: replaying the same events always gives the same projection.
 */
interface FlowNodePayload {
  nodeId: RunNodeKind;
  status: FlowNodeStatus;
  reason?: string;
}

function upsertNode(
  progress: FlowProgress,
  byNode: Map<RunNodeKind, FlowNodeProgress>,
  payload: FlowNodePayload,
): FlowNodeProgress {
  const existing = byNode.get(payload.nodeId);
  if (existing) return existing;
  const created: FlowNodeProgress = {
    nodeId: payload.nodeId,
    status: payload.status,
    attempts: 0,
  };
  byNode.set(payload.nodeId, created);
  progress.nodes.push(created);
  return created;
}

function applyTiming(node: FlowNodeProgress, payload: FlowNodePayload, occurredAt: string): void {
  if (payload.status === "started") {
    node.attempts += 1;
    node.startedAt = occurredAt;
    delete node.endedAt;
    delete node.reason;
    return;
  }
  node.endedAt = occurredAt;
  if (payload.reason) node.reason = payload.reason;
  else delete node.reason;
}

function applyCurrent(progress: FlowProgress, payload: FlowNodePayload): void {
  if (payload.status === "started" || payload.status === "parked") {
    progress.current = payload.nodeId;
    return;
  }
  if (progress.current === payload.nodeId) delete progress.current;
}

function applyNodeEvent(
  progress: FlowProgress,
  byNode: Map<RunNodeKind, FlowNodeProgress>,
  event: RunEvent,
): void {
  const payload = event.payload as FlowNodePayload;
  const node = upsertNode(progress, byNode, payload);
  node.status = payload.status;
  applyTiming(node, payload, event.occurredAt);
  applyCurrent(progress, payload);
}

function applyEvent(
  progress: FlowProgress,
  byNode: Map<RunNodeKind, FlowNodeProgress>,
  event: RunEvent,
): void {
  if (event.type === "flow.selected") {
    progress.selection = event.payload as FlowSelection;
    return;
  }
  if (event.type === "flow.triage") {
    (progress.triage ??= []).push(event.payload as TriageEvent);
    return;
  }
  if (event.type !== "flow.node") return;
  applyNodeEvent(progress, byNode, event);
}

export function foldFlowEvents(events: readonly RunEvent[]): FlowProgress {
  const progress: FlowProgress = { nodes: [] };
  const byNode = new Map<RunNodeKind, FlowNodeProgress>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    applyEvent(progress, byNode, event);
  }
  return progress;
}
