import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  Bot,
  Check,
  CircleAlert,
  GitPullRequest,
  LockKeyhole,
  Network,
  PanelLeftOpen,
  Play,
  RotateCcw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  CompiledStrategyStage,
  CompiledStrategyTopology,
  PublicConfig,
  StrategyDefinition,
  StrategyBlueprintDefinition,
  StrategyBlueprintResult,
  StrategyTopologyMode,
} from "../types";

const nodeTypes = { strategyStage: StrategyStageNode };
const roleOrder = ["orchestrator", "architect", "worker", "reviewer", "tester"];

interface StrategyDraft {
  mode: StrategyTopologyMode;
  maxParallel: number;
  maxReworkAttempts: number;
  maxAgentInvocations: number;
  planApproval: boolean;
  roleProfiles: Record<string, string>;
}

interface StrategyNodeData extends Record<string, unknown> {
  stage: CompiledStrategyStage;
  sourcePosition: Position;
  targetPosition: Position;
}

interface StrategyComposerProps {
  config: PublicConfig;
  onPreflight(name: string, definition: StrategyBlueprintDefinition): Promise<StrategyBlueprintResult>;
  onSave(name: string, definition: StrategyBlueprintDefinition): Promise<StrategyBlueprintResult>;
  onDelete(name: string): Promise<void>;
  onLaunch(name: string): void;
}

interface ComposerFeedback {
  kind: "valid" | "saved" | "error";
  message: string;
}

export function StrategyComposer({
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
  const [compactLayout, setCompactLayout] = useState(() => isCompactLayout());
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(() => !isCompactLayout());

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
  }, [definition.source, selectedName]);

  useEffect(() => {
    if (pendingSelection && config.strategies.definitions[pendingSelection]) {
      setSelectedName(pendingSelection);
      setPendingSelection(undefined);
    }
  }, [config.strategies.definitions, pendingSelection]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 800px)");
    const updateLayout = () => {
      setCompactLayout(mediaQuery.matches);
      if (mediaQuery.matches) {
        setLibraryOpen(false);
        setInspectorOpen(false);
      }
    };
    updateLayout();
    mediaQuery.addEventListener("change", updateLayout);
    return () => mediaQuery.removeEventListener("change", updateLayout);
  }, []);

  const topology = useMemo(
    () => buildPreviewTopology(definition.compiledTopology, draft),
    [definition.compiledTopology, draft],
  );
  const graph = useMemo(
    () => buildStrategyGraph(topology, compactLayout),
    [compactLayout, topology],
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

  const updateNumber = (
    field: "maxParallel" | "maxReworkAttempts" | "maxAgentInvocations",
    value: number,
  ) => updateDraft((current) => ({ ...current, [field]: value }));

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

  return (
    <section
      className={`strategy-composer ${libraryOpen ? "library-open" : ""} ${inspectorOpen ? "inspector-open" : ""}`}
      aria-label="策略编排器"
      aria-busy={submitting}
    >
      <main className="composer-canvas">
        <header className="composer-toolbar">
          <div className="composer-toolbar-group">
            <button
              className={`button secondary toolbar-toggle ${libraryOpen ? "is-active" : ""}`}
              onClick={() => setLibraryOpen((open) => !open)}
              aria-pressed={libraryOpen}
              title="打开策略库"
            >
              <PanelLeftOpen size={16} /><span>策略库</span>
            </button>
            <div className="composer-title">
              <span className="section-kicker">STRATEGY GRAPH</span>
              <select
                className="composer-strategy-select"
                aria-label="策略模板"
                value={selectedName}
                onChange={(event) => selectStrategy(event.target.value)}
                disabled={submitting}
              >
                {strategyNames.map((name) => <option key={name}>{name}</option>)}
              </select>
            </div>
          </div>
          <div className="composer-toolbar-actions">
            <div className={`composer-validation ${feedback?.kind === "error" ? "is-error" : ""}`}>
              {feedback?.kind === "error" ? <CircleAlert size={14} /> : <Check size={14} />}
              <span>{feedback?.message ?? (dirty ? "草稿待预检" : "已加载策略")}</span>
            </div>
            <button
              className={`button secondary toolbar-toggle ${inspectorOpen ? "is-active" : ""}`}
              onClick={() => setInspectorOpen((open) => !open)}
              aria-pressed={inspectorOpen}
              title="策略设置"
            >
              <SlidersHorizontal size={16} /><span>策略设置</span>
            </button>
            <span className="toolbar-divider" />
            <button className="button secondary" onClick={() => void runAction("preflight")} disabled={submitting || !blueprintName.trim()} title="预检策略" aria-label="预检">
              <ShieldCheck size={15} /><span>预检</span>
            </button>
            <button className="button secondary" onClick={() => void runAction("save")} disabled={submitting || !blueprintName.trim()} title="保存策略" aria-label="保存">
              <Save size={15} /><span>保存</span>
            </button>
            <button className="button primary" onClick={() => onLaunch(selectedName)} disabled={submitting || dirty} title={dirty ? "请先保存当前草稿" : "使用已保存策略启动运行"} aria-label="运行">
              <Play size={15} fill="currentColor" /><span>运行</span>
            </button>
          </div>
        </header>
        <div className="composer-flow" aria-label="策略阶段图">
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
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#cbd5d1" />
            <Controls showInteractive={false} />
          </ReactFlow>
          <div className="composer-canvas-summary">
            <span><strong>{topology.stages.length}</strong> 阶段</span>
            <span><strong>{topologyModeLabel(draft.mode)}</strong> 拓扑</span>
            <span><strong>{draft.mode === "sequential" ? 1 : draft.maxParallel}</strong> 并行上限</span>
            <span className={draft.planApproval ? "is-enabled" : ""}><strong>{draft.planApproval ? "已启用" : "未启用"}</strong> 计划审批</span>
          </div>
        </div>
      </main>

      <aside className="composer-library" aria-hidden={!libraryOpen} inert={!libraryOpen}>
        <header className="drawer-header">
          <div><span className="section-kicker">LIBRARY</span><h2>策略与阶段</h2></div>
          <button className="icon-button" onClick={() => setLibraryOpen(false)} title="关闭策略库" aria-label="关闭策略库"><X size={17} /></button>
        </header>
        <div className="composer-strategy-list">
          {strategyNames.map((name) => {
            const item = config.strategies.definitions[name]!;
            return (
              <button key={name} className={name === selectedName ? "is-selected" : ""} onClick={() => selectStrategy(name)} disabled={submitting}>
                <span><Network size={16} /><strong>{name}</strong></span>
                <small>{topologyModeLabel(item.topology?.mode ?? item.compiledTopology.mode)} · {item.source === "custom" ? "自定义蓝图" : "项目配置"}</small>
              </button>
            );
          })}
        </div>
        <div className="composer-palette">
          <span className="section-kicker">STAGES</span>
          <h3>执行阶段</h3>
          <PaletteItem icon={<Bot size={16} />} label="Agent 阶段" locked />
          <PaletteItem icon={<Users size={16} />} label="Worker Pool" locked />
          <PaletteItem icon={<ShieldCheck size={16} />} label="质量门禁" locked />
          <button className={`palette-item ${draft.planApproval ? "is-active" : ""}`} onClick={() => updateDraft((current) => ({ ...current, planApproval: !current.planApproval }))} aria-pressed={draft.planApproval} disabled={submitting}>
            <span><Check size={16} />计划审批</span><small>{draft.planApproval ? "已启用" : "可添加"}</small>
          </button>
          <PaletteItem icon={<GitPullRequest size={16} />} label="发布边界" locked />
        </div>
      </aside>

      <aside className="composer-inspector" aria-hidden={!inspectorOpen} inert={!inspectorOpen}>
        <header className="section-heading composer-inspector-header">
          <div>
            <span className="section-kicker">POLICY</span>
            <h2>策略属性</h2>
          </div>
          <div className="composer-inspector-tools">
            <button
              className="icon-button"
              onClick={() => {
                setDraft(createDraft(definition, config));
                setFeedback(undefined);
              }}
              title="重置策略草稿"
              aria-label="重置策略草稿"
              disabled={submitting}
            >
              <RotateCcw size={16} />
            </button>
            {definition.source === "custom" && (
              <button
                className="icon-button danger-icon"
                onClick={() => {
                  if (window.confirm(`删除自定义策略 ${selectedName}？`)) void runAction("delete");
                }}
                disabled={submitting}
                title="删除自定义策略"
                aria-label="删除自定义策略"
              >
                <Trash2 size={16} />
              </button>
            )}
            <button className="icon-button" onClick={() => setInspectorOpen(false)} title="关闭策略设置" aria-label="关闭策略设置"><X size={17} /></button>
          </div>
        </header>
        <div className="composer-inspector-scroll">
          <section className="composer-form-section blueprint-identity">
            <label>
              <span className="field-label">蓝图名称</span>
              <input
                value={blueprintName}
                onChange={(event) => {
                  setBlueprintName(event.target.value);
                  setFeedback(undefined);
                }}
                aria-label="策略蓝图名称"
                spellCheck={false}
                disabled={submitting}
              />
            </label>
            <small>{definition.source === "custom" ? "自定义策略，可原名更新" : "配置策略只读，将另存为自定义蓝图"}</small>
          </section>
          <section className="composer-form-section">
            <span className="field-label">执行拓扑</span>
            <div className="topology-segments" role="group" aria-label="执行拓扑">
              <button
                className={draft.mode === "parallel-dag" ? "is-selected" : ""}
                aria-pressed={draft.mode === "parallel-dag"}
                onClick={() => updateDraft((current) => ({ ...current, mode: "parallel-dag" }))}
                disabled={submitting}
              >并行 DAG</button>
              <button
                className={draft.mode === "sequential" ? "is-selected" : ""}
                aria-pressed={draft.mode === "sequential"}
                onClick={() => updateDraft((current) => ({ ...current, mode: "sequential", maxParallel: 1 }))}
                disabled={submitting}
              >串行</button>
            </div>
          </section>
          <section className="composer-form-section policy-number-grid">
            <NumberField
              label="并行上限"
              value={draft.mode === "sequential" ? 1 : draft.maxParallel}
              min={1}
              max={32}
              disabled={submitting || draft.mode === "sequential"}
              onChange={(value) => updateNumber("maxParallel", value)}
            />
            <NumberField
              label="返工上限"
              value={draft.maxReworkAttempts}
              min={0}
              max={10}
              disabled={submitting}
              onChange={(value) => updateNumber("maxReworkAttempts", value)}
            />
            <NumberField
              label="Agent 调用"
              value={draft.maxAgentInvocations}
              min={1}
              max={1000}
              disabled={submitting}
              onChange={(value) => updateNumber("maxAgentInvocations", value)}
            />
          </section>
          <section className="composer-form-section">
            <label className="policy-toggle">
              <span><strong>计划审批</strong><small>Worker 执行前暂停</small></span>
              <input
                type="checkbox"
                checked={draft.planApproval}
                onChange={(event) => updateDraft((current) => ({ ...current, planApproval: event.target.checked }))}
                disabled={submitting}
              />
            </label>
          </section>
          <section className="composer-form-section role-policy-list">
            <h3>角色 Profile</h3>
            {roleOrder.map((role) => {
              const policy = config.roles[role];
              if (!policy) return null;
              return (
                <label key={role}>
                  <span>{role}</span>
                  <select
                    value={draft.roleProfiles[role] ?? ""}
                    disabled={submitting}
                    onChange={(event) => updateDraft((current) => {
                      const roleProfiles = { ...current.roleProfiles };
                      if (event.target.value) roleProfiles[role] = event.target.value;
                      else delete roleProfiles[role];
                      return { ...current, roleProfiles };
                    })}
                  >
                    <option value="">策略默认 ({policy.defaultProfile})</option>
                    {policy.allowedProfiles.map((profile) => <option key={profile}>{profile}</option>)}
                  </select>
                </label>
              );
            })}
          </section>
        </div>
      </aside>
    </section>
  );
}

function PaletteItem({ icon, label, locked }: { icon: React.ReactNode; label: string; locked: boolean }) {
  return (
    <div className="palette-item">
      <span>{icon}{label}</span>
      {locked && <LockKeyhole size={12} aria-label="固定阶段" />}
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  disabled = false,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange(value: number): void;
}) {
  return (
    <label className="number-field">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(event) => {
          const valueAsNumber = event.target.valueAsNumber;
          if (Number.isFinite(valueAsNumber)) onChange(Math.min(max, Math.max(min, valueAsNumber)));
        }}
      />
    </label>
  );
}

function StrategyStageNode({ data, selected }: NodeProps) {
  const { stage, sourcePosition, targetPosition } = data as StrategyNodeData;
  const icon = stage.kind === "worker-pool"
    ? <Users size={16} />
    : stage.kind === "human-approval" || stage.kind === "quality-gate"
      ? <ShieldCheck size={16} />
      : stage.kind === "publication"
        ? <GitPullRequest size={16} />
        : <Bot size={16} />;
  return (
    <div className={`strategy-stage-node kind-${stage.kind} ${selected ? "is-selected" : ""}`}>
      <Handle type="target" position={targetPosition} />
      <span className="strategy-stage-icon">{icon}</span>
      <span>
        <small>{stageKindLabel(stage.kind)}</small>
        <strong>{stage.label}</strong>
        {stage.roles.length > 0 && <code>{stage.roles.join(" + ")}</code>}
      </span>
      <Handle type="source" position={sourcePosition} />
    </div>
  );
}

function createDraft(definition: StrategyDefinition, config: PublicConfig): StrategyDraft {
  return {
    mode: definition.topology?.mode ?? definition.compiledTopology.mode,
    maxParallel: definition.maxParallel ?? config.project.maxParallel,
    maxReworkAttempts: definition.maxReworkAttempts ?? 0,
    maxAgentInvocations: definition.maxAgentInvocations ?? 64,
    planApproval: definition.approvalGates?.includes("plan") ?? false,
    roleProfiles: { ...(definition.roleProfiles ?? {}) },
  };
}

function buildBlueprintDefinition(
  definition: StrategyDefinition,
  draft: StrategyDraft,
): StrategyBlueprintDefinition {
  const { compiledTopology: _compiledTopology, source: _source, ...persisted } = definition;
  return {
    ...persisted,
    topology: { mode: draft.mode },
    maxParallel: draft.mode === "sequential" ? 1 : draft.maxParallel,
    maxReworkAttempts: draft.maxReworkAttempts,
    maxAgentInvocations: draft.maxAgentInvocations,
    roleProfiles: { ...draft.roleProfiles },
    approvalGates: draft.planApproval ? ["plan", "final"] : ["final"],
  };
}

function blueprintNameFor(name: string, definition: StrategyDefinition): string {
  return definition.source === "custom" ? name : `${name}-custom`;
}

function sameDraft(left: StrategyDraft, right: StrategyDraft): boolean {
  if (
    left.mode !== right.mode ||
    left.maxParallel !== right.maxParallel ||
    left.maxReworkAttempts !== right.maxReworkAttempts ||
    left.maxAgentInvocations !== right.maxAgentInvocations ||
    left.planApproval !== right.planApproval
  ) {
    return false;
  }
  const roles = new Set([
    ...Object.keys(left.roleProfiles),
    ...Object.keys(right.roleProfiles),
  ]);
  return [...roles].every((role) => left.roleProfiles[role] === right.roleProfiles[role]);
}

function buildPreviewTopology(
  compiled: CompiledStrategyTopology,
  draft: StrategyDraft,
): CompiledStrategyTopology {
  let stages = compiled.stages.filter((stage) => stage.id !== "plan-approval");
  if (draft.planApproval) {
    const architectureIndex = stages.findIndex((stage) => stage.id === "architecture");
    stages = [
      ...stages.slice(0, architectureIndex + 1),
      { id: "plan-approval", kind: "human-approval", label: "计划审批", roles: [] },
      ...stages.slice(architectureIndex + 1),
    ];
  }
  stages = stages.map((stage) => stage.id === "task-execution"
    ? { ...stage, label: draft.mode === "sequential" ? "串行执行" : "并行执行" }
    : stage);
  return {
    version: 1,
    mode: draft.mode,
    stages,
    edges: stages.slice(1).map((stage, index) => ({ source: stages[index]!.id, target: stage.id })),
  };
}

function buildStrategyGraph(
  topology: CompiledStrategyTopology,
  compact: boolean,
): { nodes: Array<Node<StrategyNodeData>>; edges: Edge[] } {
  const columns = compact ? 2 : 3;
  const nodes = topology.stages.map((stage, index) => {
    const row = Math.floor(index / columns);
    const offset = index % columns;
    const column = row % 2 === 0 ? offset : columns - 1 - offset;
    const startsRow = offset === 0 && row > 0;
    const endsRow = offset === columns - 1 && index < topology.stages.length - 1;
    const horizontalSource = row % 2 === 0 ? Position.Right : Position.Left;
    const horizontalTarget = row % 2 === 0 ? Position.Left : Position.Right;
    return {
      id: stage.id,
      type: "strategyStage",
      position: { x: column * 270, y: row * 160 },
      data: {
        stage,
        sourcePosition: endsRow ? Position.Bottom : horizontalSource,
        targetPosition: startsRow ? Position.Top : horizontalTarget,
      },
    };
  });
  const edges = topology.edges.map((edge) => ({
    id: `${edge.source}-${edge.target}`,
    source: edge.source,
    target: edge.target,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    style: { stroke: "#81877d", strokeWidth: 1.5 },
  }));
  return { nodes, edges };
}

function topologyModeLabel(mode: StrategyTopologyMode): string {
  return mode === "sequential" ? "串行" : "并行 DAG";
}

function isCompactLayout(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 800px)").matches;
}

function stageKindLabel(kind: CompiledStrategyStage["kind"]): string {
  return {
    agent: "AGENT",
    "worker-pool": "WORKER POOL",
    "quality-gate": "QUALITY GATE",
    "human-approval": "HUMAN GATE",
    publication: "PUBLISH",
  }[kind];
}
