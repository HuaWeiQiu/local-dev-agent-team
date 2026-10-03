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
export function foldFlowEvents(events: readonly RunEvent[]): FlowProgress {
  const progress: FlowProgress = { nodes: [] };
  const byNode = new Map<RunNodeKind, FlowNodeProgress>();

  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.type === "flow.selected") {
      progress.selection = event.payload as FlowSelection;
      continue;
    }
    if (event.type === "flow.triage") {
      (progress.triage ??= []).push(event.payload as TriageEvent);
      continue;
    }
    if (event.type !== "flow.node") continue;
    const payload = event.payload as { nodeId: RunNodeKind; status: FlowNodeStatus; reason?: string };
    let node = byNode.get(payload.nodeId);
    if (!node) {
      node = { nodeId: payload.nodeId, status: payload.status, attempts: 0 };
      byNode.set(payload.nodeId, node);
      progress.nodes.push(node);
    }
    node.status = payload.status;
    if (payload.status === "started") {
      node.attempts += 1;
      node.startedAt = event.occurredAt;
      delete node.endedAt;
      delete node.reason;
    } else {
      node.endedAt = event.occurredAt;
      if (payload.reason) node.reason = payload.reason;
      else delete node.reason;
    }
    if (payload.status === "started" || payload.status === "parked") {
      progress.current = payload.nodeId;
    } else if (progress.current === payload.nodeId) {
      delete progress.current;
    }
  }
  return progress;
}
