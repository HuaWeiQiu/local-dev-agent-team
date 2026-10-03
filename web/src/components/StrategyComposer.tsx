import { Background, BackgroundVariant, Controls, ReactFlow } from "@xyflow/react";
import { Network, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useFlowPalette } from "../flow-theme";
import { useMediaQuery } from "../useMediaQuery";
import type {
  PublicConfig,
  StrategyBlueprintDefinition,
  StrategyBlueprintResult,
} from "../types";
import { cn } from "../ui/cn";
import { Callout } from "../ui/form";
import { ComposerToolbar } from "./strategy/ComposerToolbar";
import {
  blueprintNameFor,
  buildBlueprintDefinition,
  buildPreviewTopology,
  buildStrategyGraph,
  createDraft,
  sameDraft,
  topologyModeLabel,
  type ComposerFeedback,
  type StrategyDraft,
} from "./strategy/draft";
import { InspectorPanel } from "./strategy/InspectorPanel";
import { LibraryPanel } from "./strategy/LibraryPanel";
import { StrategyStageNode } from "./strategy/StageNode";

const nodeTypes = { strategyStage: StrategyStageNode };

interface StrategyComposerProps {
  config: PublicConfig;
  onPreflight(name: string, definition: StrategyBlueprintDefinition): Promise<StrategyBlueprintResult>;
  onSave(name: string, definition: StrategyBlueprintDefinition): Promise<StrategyBlueprintResult>;
  onDelete(name: string): Promise<void>;
  onLaunch(name: string): void;
}

export function StrategyComposer(props: StrategyComposerProps) {
  if (Object.keys(props.config.strategies.definitions).length === 0) {
    return (
      <section aria-label="策略编排器" className="grid h-full place-items-center bg-background p-6">
        <div className="flex max-w-sm flex-col items-center gap-2 text-center">
          <span aria-hidden className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent-ink">
            <Workflow className="size-5" />
          </span>
          <strong className="text-base font-semibold text-ink">还没有可编排的策略</strong>
          <span className="text-sm leading-relaxed text-muted">
            在项目配置中定义策略后，可在这里可视化调整阶段与限额，并保存为自定义蓝图。
          </span>
        </div>
      </section>
    );
  }
  return <StrategyWorkspace {...props} />;
}

function StrategyWorkspace({
  config,
  onPreflight,
  onSave,
  onDelete,
  onLaunch,
}: StrategyComposerProps) {
  const strategyNames = Object.keys(config.strategies.definitions);
  const [selectedName, setSelectedName] = useState(config.strategies.default);
  const definition = config.strategies.definitions[selectedName]
    ?? config.strategies.definitions[config.strategies.default]!;
  const [draft, setDraft] = useState<StrategyDraft>(() => createDraft(definition, config));
  const [blueprintName, setBlueprintName] = useState(() => blueprintNameFor(selectedName, definition));
  const [pendingSelection, setPendingSelection] = useState<string>();
  const [feedback, setFeedback] = useState<ComposerFeedback>();
  const [submitting, setSubmitting] = useState(false);
  const compactLayout = useMediaQuery("(max-width: 800px)");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(() => !compactLayout);

  useEffect(() => {
    if (!config.strategies.definitions[selectedName]) {
      setSelectedName(config.strategies.default);
    }
  }, [config.strategies.default, config.strategies.definitions, selectedName]);

  useEffect(() => {
    setDraft(createDraft(definition, config));
  }, [config, definition, selectedName]);

  useEffect(() => {
    setBlueprintName(blueprintNameFor(selectedName, definition));
    // Only a change of source or selection should rename; other edits keep the typed name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition.source, selectedName]);

  useEffect(() => {
    if (pendingSelection && config.strategies.definitions[pendingSelection]) {
      setSelectedName(pendingSelection);
      setPendingSelection(undefined);
    }
  }, [config.strategies.definitions, pendingSelection]);

  useEffect(() => {
    if (compactLayout) {
      setLibraryOpen(false);
      setInspectorOpen(false);
    }
  }, [compactLayout]);

  const palette = useFlowPalette();
  const topology = useMemo(
    () => buildPreviewTopology(definition.compiledTopology, draft),
    [definition.compiledTopology, draft],
  );
  const graph = useMemo(
    () => buildStrategyGraph(topology, compactLayout, palette.edge),
    [compactLayout, palette.edge, topology],
  );
  const persistedDraft = useMemo(() => createDraft(definition, config), [config, definition]);
  const dirty = !sameDraft(draft, persistedDraft);
  const blueprintDefinition = useMemo(
    () => buildBlueprintDefinition(definition, draft),
    [definition, draft],
  );

  const updateDraft = (update: (current: StrategyDraft) => StrategyDraft) => {
    setFeedback(undefined);
    setDraft(update);
  };

  const selectStrategy = (name: string) => {
    setFeedback(undefined);
    setSelectedName(name);
  };

  const runAction = async (action: "preflight" | "save" | "delete") => {
    const targetName = blueprintName.trim();
    setSubmitting(true);
    setFeedback(undefined);
    try {
      if (action === "delete") {
        await onDelete(selectedName);
        setFeedback({ kind: "saved", message: "蓝图已删除" });
        return;
      }
      const result = action === "save"
        ? await onSave(targetName, blueprintDefinition)
        : await onPreflight(targetName, blueprintDefinition);
      if (action === "save") {
        setPendingSelection(result.name);
        setFeedback({ kind: "saved", message: "已保存并编译" });
      } else {
        setFeedback({ kind: "valid", message: "服务端预检通过" });
      }
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const sequential = draft.mode === "sequential";
  const panelOpen = libraryOpen || inspectorOpen;

  return (
    <section
      className="strategy-composer @container relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background"
      aria-label="策略编排器"
      aria-busy={submitting}
    >
      <ComposerToolbar
        strategyNames={strategyNames}
        selectedName={selectedName}
        libraryOpen={libraryOpen}
        inspectorOpen={inspectorOpen}
        submitting={submitting}
        dirty={dirty}
        canSubmit={blueprintName.trim().length > 0}
        feedback={feedback}
        onSelect={selectStrategy}
        onToggleLibrary={() => setLibraryOpen((open) => !open)}
        onToggleInspector={() => setInspectorOpen((open) => !open)}
        onPreflight={() => void runAction("preflight")}
        onSave={() => void runAction("save")}
        onLaunch={() => onLaunch(selectedName)}
      />

      <div className="relative min-h-0 flex-1">
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
            onNodeClick={() => setInspectorOpen(true)}
            minZoom={0.45}
            maxZoom={1.4}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} color={palette.dot} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        {topology.stages.length === 0 && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="flex flex-col items-center gap-2 text-center text-sm text-muted">
              <Network aria-hidden className="size-6" />
              该策略暂无可展示的阶段
            </div>
          </div>
        )}

        {feedback?.kind === "error" && (
          <Callout
            tone="danger"
            role="alert"
            className="bd absolute left-3 top-3 z-10 max-w-[min(32rem,calc(100%-1.5rem))] shadow-pop"
          >
            <span className="break-words">{feedback.message}</span>
          </Callout>
        )}

        <div className="composer-canvas-summary bd scroll-thin absolute inset-x-0 bottom-4 z-10 mx-auto flex w-fit max-w-[calc(100%-2rem)] overflow-x-auto rounded-xl bg-surface/90 text-xs shadow-card backdrop-blur">
          <SummaryItem label="阶段" value={String(topology.stages.length)} />
          <SummaryItem label="拓扑" value={topologyModeLabel(draft.mode)} />
          <SummaryItem label="并行上限" value={String(sequential ? 1 : draft.maxParallel)} />
          <SummaryItem label="Swarm 并发" value={String(sequential ? 1 : Math.min(draft.swarmMaxConcurrency, draft.maxParallel))} />
          <SummaryItem label="探索" value={draft.exploreEnabled ? "已启用" : "未启用"} on={draft.exploreEnabled} />
          <SummaryItem label="架构顾问" value={draft.advisorEnabled ? "已启用" : "未启用"} on={draft.advisorEnabled} />
          <SummaryItem label="计划审批" value={draft.planApproval ? "已启用" : "未启用"} on={draft.planApproval} />
        </div>

        {compactLayout && panelOpen && (
          <div
            aria-hidden
            className="absolute inset-0 z-10 bg-scrim"
            onClick={() => {
              setLibraryOpen(false);
              setInspectorOpen(false);
            }}
          />
        )}

        <LibraryPanel
          open={libraryOpen}
          compact={compactLayout}
          strategyNames={strategyNames}
          definitions={config.strategies.definitions}
          selectedName={selectedName}
          planApproval={draft.planApproval}
          submitting={submitting}
          onSelect={selectStrategy}
          onTogglePlanApproval={() => updateDraft((current) => ({ ...current, planApproval: !current.planApproval }))}
          onClose={() => setLibraryOpen(false)}
        />

        <InspectorPanel
          open={inspectorOpen}
          compact={compactLayout}
          config={config}
          definition={definition}
          selectedName={selectedName}
          draft={draft}
          blueprintName={blueprintName}
          submitting={submitting}
          onBlueprintNameChange={(name) => {
            setBlueprintName(name);
            setFeedback(undefined);
          }}
          onDraft={updateDraft}
          onReset={() => {
            setDraft(createDraft(definition, config));
            setFeedback(undefined);
          }}
          onDelete={() => void runAction("delete")}
          onClose={() => setInspectorOpen(false)}
        />
      </div>
    </section>
  );
}

function SummaryItem({ label, value, on }: { label: string; value: string; on?: boolean }) {
  return (
    <div className="not-last:bd-r flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2">
      <small className="text-xs text-muted">{label}</small>
      {on !== undefined && (
        <i aria-hidden className={cn("size-1.5 rounded-full", on ? "bg-success" : "bg-line-strong")} />
      )}
      <strong className={cn("font-semibold", on ? "text-success-ink" : "text-ink")}>{value}</strong>
    </div>
  );
}
