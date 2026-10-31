import {
  ARCHITECTURE_KIND_LABEL,
  ARCHITECTURE_RELATION_LABEL,
  type ArchitectureBox,
  type ArchitectureDiagram as Diagram,
  type ArchitectureEdge,
  type ArchitecturePresentation,
  type ModuleStatus,
} from "../../../architecture";
import type { ArchitectureDesign, RepoTrace } from "../../../types";

export const STATUS_LABEL: Record<ModuleStatus, string> = {
  working: "进行中",
  blocked: "被阻塞",
  done: "已完成",
  pending: "未开始",
  mixed: "部分完成",
};

export const STATUS_DOT: Record<ModuleStatus, string> = {
  working: "bg-accent",
  blocked: "bg-danger",
  done: "bg-success",
  pending: "bg-muted/50",
  mixed: "bg-warning",
};

/** Paths worth listing under the diagram; empty when the trace adds nothing. */
export function traceLeaves(trace: RepoTrace | undefined): string[] {
  if (!trace) return [];
  const paths = trace.nodes.map((node) => node.path).filter((item) => item.length > 0);
  const leaves = paths.filter(
    (path) => !paths.some((other) => other !== path && other.startsWith(`${path}/`)),
  );
  return leaves.slice(0, 8);
}

/** The module that owns a path: longest covering path wins. */
export function moduleForPath(
  boxes: Array<{ id: string; paths: string[] }>,
  path: string,
): string | undefined {
  let best: { id: string; length: number } | undefined;
  for (const box of boxes) {
    for (const owned of box.paths) {
      if (!covers(owned, path)) continue;
      if (!best || owned.length > best.length) best = { id: box.id, length: owned.length };
    }
  }
  return best?.id;
}

function covers(owned: string, path: string): boolean {
  return path === owned || path.startsWith(`${owned}/`) || owned.startsWith(`${path}/`);
}

/** The focused module, only when it still exists in this diagram. */
export function focusOf(diagram: Diagram, selectedModuleId: string | undefined): string | undefined {
  if (!selectedModuleId) return undefined;
  return diagram.boxes.some((box) => box.id === selectedModuleId) ? selectedModuleId : undefined;
}

/** The focused module plus its direct neighbours. */
export function neighborhoodOf(diagram: Diagram, focused: string | undefined): Set<string> {
  const neighborhood = new Set<string>();
  if (!focused) return neighborhood;
  neighborhood.add(focused);
  for (const edge of diagram.edges) {
    if (edge.from === focused) neighborhood.add(edge.to);
    if (edge.to === focused) neighborhood.add(edge.from);
  }
  return neighborhood;
}

/** Sequence steps to show: the neighbourhood of a focused module, else all. */
export function stepsFor(
  presentation: ArchitecturePresentation,
  focused: string | undefined,
  neighborhood: Set<string>,
): ArchitectureDesign["sequence"] {
  if (!focused) return presentation.sequence;
  return presentation.sequence.filter(
    (step) => neighborhood.has(step.from) || neighborhood.has(step.to),
  );
}

export interface EdgeGeometry {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  mid: number;
  vertical: boolean;
  caption: string | undefined;
}

/** Curve endpoints for one relation, plus the label and orientation. */
export function edgeGeometry(
  edge: ArchitectureEdge,
  from: ArchitectureBox,
  to: ArchitectureBox,
): EdgeGeometry {
  const x1 = from.x + from.width / 2;
  const y1 = from.y + from.height;
  const x2 = to.x + to.width / 2;
  const y2 = to.y;
  return {
    x1,
    y1,
    x2,
    y2,
    mid: (y1 + y2) / 2,
    vertical: Math.abs(x1 - x2) < 24,
    caption: edge.label ?? (edge.kind ? ARCHITECTURE_RELATION_LABEL[edge.kind] : undefined),
  };
}

/** Secondary line inside a module box: responsibility, else kind + status. */
export function boxSubtitle(box: ArchitectureBox): string {
  if (box.responsibility) return box.responsibility;
  const kind = box.kind ? `${ARCHITECTURE_KIND_LABEL[box.kind]} · ` : "";
  return `${kind}${STATUS_LABEL[box.status]}`;
}

export function boxFooter(box: ArchitectureBox): string {
  return `${STATUS_LABEL[box.status]} · ${box.tasks.length} 个任务`;
}
