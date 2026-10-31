import { Background, BackgroundVariant, Controls, ReactFlow } from "@xyflow/react";
import { Network } from "lucide-react";
import { cn } from "../../../ui/cn";
import { Callout } from "../../../ui/form";
import type { CompiledStrategyTopology } from "../../../types";
import type { StrategyDraft } from "../draft";
import { StrategyStageNode } from "../StageNode";
import { draftSummary, type ComposerFeedback } from "./model";

export const nodeTypes = { strategyStage: StrategyStageNode };

interface StrategyGraph {
  nodes: NonNullable<Parameters<typeof ReactFlow>[0]["nodes"]>;
  edges: NonNullable<Parameters<typeof ReactFlow>[0]["edges"]>;
}

export function StrategyCanvas({
  graph,
  topology,
  draft,
  palette,
  feedback,
  onSelectStage,
}: {
  graph: StrategyGraph;
  topology: CompiledStrategyTopology;
  draft: StrategyDraft;
  palette: { dot: string; edge: string };
  feedback: ComposerFeedback | undefined;
  onSelectStage(): void;
}) {
  return (
    <>
      <div className="absolute inset-0" role="group" aria-label="策略阶段图">
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          onNodeClick={onSelectStage}
          minZoom={0.45}
          maxZoom={1.4}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color={palette.dot} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {topology.stages.length === 0 && <EmptyCanvas />}
      {feedback?.kind === "error" && <CanvasError message={feedback.message} />}
      <CanvasSummary topology={topology} draft={draft} />
    </>
  );
}

function EmptyCanvas() {
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center">
      <div className="flex flex-col items-center gap-2 text-center text-sm text-muted">
        <Network aria-hidden className="size-6" />
        该策略暂无可展示的阶段
      </div>
    </div>
  );
}

function CanvasError({ message }: { message: string }) {
  return (
    <Callout
      tone="danger"
      role="alert"
      className="bd absolute left-3 top-3 z-10 max-w-[min(32rem,calc(100%-1.5rem))] shadow-pop"
    >
      <span className="break-words">{message}</span>
    </Callout>
  );
}

function CanvasSummary({
  topology,
  draft,
}: {
  topology: CompiledStrategyTopology;
  draft: StrategyDraft;
}) {
  return (
    <div className="composer-canvas-summary bd scroll-thin absolute inset-x-0 bottom-4 z-10 mx-auto flex w-fit max-w-[calc(100%-2rem)] overflow-x-auto rounded-lg bg-surface text-xs">
      {draftSummary(topology, draft).map((row) => (
        <SummaryItem key={row.label} label={row.label} value={row.value} {...(row.on !== undefined ? { on: row.on } : {})} />
      ))}
    </div>
  );
}

export function SummaryItem({ label, value, on }: { label: string; value: string; on?: boolean }) {
  return (
    <div className="not-last:bd-r flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2">
      <span className="text-muted">{label}</span>
      <strong className={cn("font-semibold tabular-nums", on ? "text-success-ink" : "text-ink-2")}>
        {value}
      </strong>
    </div>
  );
}
