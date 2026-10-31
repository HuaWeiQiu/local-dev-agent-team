import { deriveStages, stageDefinitions, type StageId, type StageState, type StageView } from "./stages";
import { agentRoleLabel } from "./presentation";
import type { ArchitectureDesign, ArchitectureRelationKind, ArchitectureSource, RunEvent, RunState, RunStatus, TaskRunState } from "./types";

const STAGE_ROLES: Record<StageId, string[]> = {
  intake: ["orchestrator"],
  explore: ["researcher"],
  plan: ["architect"],
  build: ["worker"],
  review: ["reviewer", "tester"],
  integrate: ["orchestrator"],
  gates: ["orchestrator", "tester"],
  approval: [],
  ship: ["orchestrator"],
};

const STAGE_HINT: Record<StageId, string> = {
  intake: "总控在读目标、约束和仓库上下文。点开可看它正在说什么。",
  explore: "研究员只读探索技术背景，结果会注入规划。",
  plan: "架构先给出系统设计，再拆成任务。点开看设计摘要和每个元素的职责。",
  build: "工人在独立 worktree 里改代码。点任务看路径、命令和输出。",
  review: "审查和测试独立于工人，失败会否决合并。",
  integrate: "通过的任务按稳定顺序合入集成分支。",
  gates: "确定性质量命令再跑一遍；失败不能被模型说成通过。",
  approval: "等人确认计划或交付物。",
  ship: "发布草稿 PR、等 CI，必要时做一次受限修复。",
};

export interface StageArtifact {
  title: string;
  body: string;
}

export interface StageLedgerEntry {
  at: string;
  label: string;
  detail?: string;
}

export interface StageBrief {
  stage: StageView;
  headline: string;
  hint: string;
  history: Array<{ at: string; message: string }>;
  agents: Array<{ role: string; label: string; status: "running" | "done" | "failed"; note?: string }>;
  liveText?: string;
  artifact?: StageArtifact;
  /** What this step received. A click is a snapshot of that step, not the whole run. */
  input?: string;
  /** Extra attempts, flaky reruns, and triage events on this step. */
  retries?: number;
  ledger: StageLedgerEntry[];
  tasks: TaskRunState[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function statusesOf(id: StageId): RunStatus[] {
  return stageDefinitions.find((stage) => stage.id === id)?.statuses ?? [];
}

function invocationRole(event: RunEvent): string | undefined {
  return text(record(event.payload)?.role);
}

function lastStdout(events: RunEvent[], roles: string[]): string | undefined {
  const wanted = new Set(roles);
  const live = new Set<string>();
  let latest: string | undefined;
  for (const event of events) {
    const update = liveUpdate(event, wanted, live);
    if (update === undefined) continue;
    if (update.kind === "output") latest = update.text;
  }
  return latest;
}

type LiveUpdate =
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "output"; text: string };

/** Track which invocations are live and surface the newest output line. */
function liveUpdate(event: RunEvent, wanted: Set<string>, live: Set<string>): LiveUpdate | undefined {
  const payload = record(event.payload);
  const id = text(payload?.invocationId);
  if (!id) return undefined;
  if (event.type === "agent.invocation.started") {
    return startInvocation(id, invocationRole(event), wanted, live);
  }
  if (event.type === "agent.invocation.completed") {
    live.delete(id);
    return { kind: "end" };
  }
  return outputUpdate(event, id, live, payload);
}

function outputUpdate(
  event: RunEvent,
  id: string,
  live: Set<string>,
  payload: Record<string, unknown> | undefined,
): LiveUpdate | undefined {
  if (!isOutputEvent(event)) return undefined;
  if (!live.has(id)) return undefined;
  const chunk = text(payload?.text);
  return chunk ? { kind: "output", text: chunk.trim() } : undefined;
}

function isOutputEvent(event: RunEvent): boolean {
  return event.type === "agent.stdout" || event.type === "agent.stderr";
}

function startInvocation(
  id: string,
  role: string | undefined,
  wanted: Set<string>,
  live: Set<string>,
): LiveUpdate | undefined {
  if (!role || !wanted.has(role)) return undefined;
  live.add(id);
  return { kind: "start" };
}

type StageReader = (run: RunState) => StageArtifact | undefined;

/** Stage artifacts: what this step produced, one reader per stage. */
const STAGE_ARTIFACTS: Partial<Record<StageId, StageReader>> = {
  intake: intakeArtifact,
  explore: exploreArtifact,
  plan: planArtifact,
  gates: gatesArtifact,
  approval: decisionArtifact,
  ship: decisionArtifact,
};

function stageArtifact(run: RunState, stageId: StageId): StageArtifact | undefined {
  const read = STAGE_ARTIFACTS[stageId];
  return read ? read(run) : undefined;
}

function intakeArtifact(run: RunState): StageArtifact | undefined {
  if (!run.intake) return undefined;
  return { title: "目标理解", body: run.intake.goalSummary };
}

function exploreArtifact(run: RunState): StageArtifact | undefined {
  if (!run.explore) return undefined;
  return { title: "探索摘要", body: exploreLines(run.explore).join("\n") };
}

function exploreLines(explore: NonNullable<RunState["explore"]>): string[] {
  return [
    explore.summary,
    explore.modules.length > 0 ? `模块：${explore.modules.join("、")}` : "",
    explore.riskPaths.length > 0 ? `风险路径：${explore.riskPaths.join("、")}` : "",
  ].filter(Boolean);
}

function planArtifact(run: RunState): StageArtifact | undefined {
  if (!run.plan) return undefined;
  const design = run.plan.design;
  if (!design) return { title: "任务计划", body: run.plan.summary };
  return { title: designTitle(design.source), body: designBody(design) };
}

function designTitle(source: ArchitectureSource): string {
  if (source === "architect") return "架构设计";
  return source === "controller" ? "控制面设计" : "推断出的结构";
}

function designBody(design: NonNullable<NonNullable<RunState["plan"]>["design"]>): string {
  return [design.summary, ...design.elements.map((element) => `${element.name}：${element.responsibility}`)]
    .filter(Boolean)
    .join("\n");
}

function gatesArtifact(run: RunState): StageArtifact | undefined {
  if (!run.finalQuality) return undefined;
  return { title: "质量报告", body: run.finalQuality.passed ? "确定性检查通过。" : "确定性检查未通过。" };
}

function decisionArtifact(run: RunState): StageArtifact | undefined {
  if (!run.finalDecision) return undefined;
  return { title: "最终决定", body: run.finalDecision.reason };
}

const STAGE_EVENT_TYPES: Partial<Record<StageId, string[]>> = {
  build: ["run.wave.started", "run.wave.completed"],
  review: ["run.advisor.consulted", "flow.triage", "quality.flaky"],
  approval: ["approval.requested", "approval.resolved"],
  gates: ["quality.flaky"],
  ship: ["run.updated"],
};

type StageInputReader = (run: RunState) => string | undefined;

/** What each stage received, one reader per stage. */
const STAGE_INPUTS: Partial<Record<StageId, StageInputReader>> = {
  intake: (run) => run.goal,
  explore: (run) => run.intake?.instructionsForArchitect ?? run.goal,
  plan: (run) => run.explore?.summary ?? run.intake?.goalSummary ?? run.goal,
  build: taskTitles,
  review: taskTitles,
  integrate: taskTitles,
  gates: qualityCommands,
  approval: pendingApprovalSummary,
  ship: (run) => run.pullRequestUrl ?? run.finalDecision?.reason,
};

function stageInput(run: RunState, stageId: StageId): string | undefined {
  const read = STAGE_INPUTS[stageId];
  return read ? read(run) : undefined;
}

function taskTitles(run: RunState): string | undefined {
  const titles = run.tasks
    .filter((task) => task.status !== "pending")
    .map((task) => task.task.title);
  return titles.length > 0 ? titles.join("\n") : undefined;
}

function qualityCommands(run: RunState): string | undefined {
  const commands = run.finalQuality?.commands?.map((command) =>
    [command.spec.command, ...command.spec.args].join(" "),
  );
  return commands && commands.length > 0 ? commands.join("\n") : undefined;
}

function pendingApprovalSummary(run: RunState): string | undefined {
  return (
    run.approvals?.find((approval) => approval.status === "pending")?.summary ??
    run.finalDecision?.reason
  );
}

function stageRetries(run: RunState, stageId: StageId, events: RunEvent[]): number {
  if (stageId !== "build" && stageId !== "review") return 0;
  const attempts = run.tasks.reduce((total, task) => total + Math.max(0, task.attempts - 1) + (task.quality?.reruns ?? 0), 0);
  const signals = events.filter((event) => event.type === "quality.flaky" || event.type === "flow.triage").length;
  return attempts + signals;
}

interface LedgerContext {
  payload: Record<string, unknown> | undefined;
  roleLabel: string;
}

type LedgerBuilder = (ctx: LedgerContext) => { label: string; detail?: string };

function ledgerContext(event: RunEvent): LedgerContext {
  const payload = record(event.payload);
  const role = text(payload?.role);
  return { payload, roleLabel: role ? agentRoleLabel(role) : "智能体" };
}

/** One line per event type; anything unlisted falls back to the raw type. */
function ledgerDetail(event: RunEvent): { label: string; detail?: string } {
  const builder = LEDGER_BUILDERS[event.type];
  return builder ? builder(ledgerContext(event)) : { label: event.type };
}

const LEDGER_BUILDERS: Record<string, LedgerBuilder> = {
  "agent.invocation.started": ({ payload, roleLabel }) => ({
    label: `${roleLabel} 开始`,
    ...profileDetail(payload),
  }),
  "agent.invocation.completed": ({ payload, roleLabel }) => ({
    label: `${roleLabel} ${payload?.success === false ? "失败" : "完成"}`,
    ...profileDetail(payload),
  }),
  "agent.stdout": ({ payload }) => outputLine(payload, "输出"),
  "agent.stderr": ({ payload }) => outputLine(payload, "错误输出"),
  "run.wave.started": ({ payload }) => waveLine(payload, "开始一批任务"),
  "run.wave.completed": ({ payload }) => waveLine(payload, "这一批结束"),
  "run.advisor.consulted": ({ payload }) => retryAdvice(payload),
  "flow.triage": ({ payload }) => retryAdvice(payload),
  "quality.flaky": () => ({ label: "不稳定命令重跑" }),
  "approval.requested": ({ payload }) => ({ label: "请求审批", ...gateDetail(payload) }),
  "approval.resolved": ({ payload }) => ({ label: "审批结果", ...gateDetail(payload) }),
};

function profileDetail(payload: Record<string, unknown> | undefined): { detail?: string } {
  const profile = text(payload?.profile);
  return profile ? { detail: profile } : {};
}

function outputLine(payload: Record<string, unknown> | undefined, label: string) {
  const chunk = text(payload?.text)?.replace(/\s+/g, " ").slice(0, 160);
  return { label, ...(chunk ? { detail: chunk } : {}) };
}

function waveLine(payload: Record<string, unknown> | undefined, label: string) {
  const ids = Array.isArray(payload?.taskIds)
    ? payload.taskIds.filter((id): id is string => typeof id === "string")
    : [];
  const detail = [ids.join("、"), text(payload?.status)].filter(Boolean).join(" · ");
  return { label, ...(detail ? { detail } : {}) };
}

function retryAdvice(payload: Record<string, unknown> | undefined) {
  const summary = text(payload?.summary) ?? text(payload?.recommendation);
  return { label: "重试或请教", ...(summary ? { detail: summary } : {}) };
}

function gateDetail(payload: Record<string, unknown> | undefined): { detail?: string } {
  const gate = text(payload?.gate);
  return gate ? { detail: gate } : {};
}

function stageLedger(events: RunEvent[], stageId: StageId, roles: string[]): StageLedgerEntry[] {
  const types = new Set(STAGE_EVENT_TYPES[stageId] ?? []);
  return events
    .filter((event) => {
      const role = invocationRole(event);
      if (role && roles.includes(role)) return true;
      return types.has(event.type);
    })
    .slice(-8)
    .map((event) => {
      const line = ledgerDetail(event);
      return { at: event.occurredAt, ...line };
    });
}

export function describeStage(run: RunState, stageId: StageId, events: RunEvent[] = []): StageBrief {
  const stage = stageViewOf(run, stageId);
  const history = stageHistory(run, stageId);
  const roles = STAGE_ROLES[stageId];
  const tasks = stageTasks(run, stageId);
  const liveText = lastStdout(events, roles);
  const artifact = stageArtifact(run, stageId);
  const input = stageInput(run, stageId);
  const retries = stageRetries(run, stageId, events);
  return {
    stage,
    headline: headlineFor(stage, history),
    hint: STAGE_HINT[stageId],
    history,
    agents: stageAgents(events, roles),
    ...(liveText ? { liveText } : {}),
    ...(artifact ? { artifact } : {}),
    ...(input ? { input } : {}),
    ...(retries > 0 ? { retries } : {}),
    ledger: stageLedger(events, stageId, roles),
    tasks: visibleTasks(stageId, tasks),
  };
}

function stageViewOf(run: RunState, stageId: StageId): StageBrief["stage"] {
  const derived = deriveStages(run).find((item) => item.id === stageId);
  if (derived) return derived;
  return {
    id: stageId,
    label: stageDefinitions.find((item) => item.id === stageId)?.label ?? stageId,
    state: "pending" as StageState,
  };
}

function stageHistory(run: RunState, stageId: StageId): StageBrief["history"] {
  const statuses = new Set(statusesOf(stageId));
  return run.history
    .filter((entry) => statuses.has(entry.status))
    .map((entry) => ({ at: entry.at, message: entry.message }))
    .slice(-6);
}

function headlineFor(stage: StageBrief["stage"], history: StageBrief["history"]): string {
  const latest = history.at(-1)?.message;
  if (latest) return latest;
  if (stage.state === "current") return `正在${stage.label}`;
  if (stage.state === "failed") return `${stage.label}在此停止`;
  if (stage.state === "done") return `${stage.label}已完成`;
  if (stage.state === "skipped") return `${stage.label}已跳过`;
  return `尚未开始${stage.label}`;
}

/** Which tasks belong on this stage's card. */
function stageTasks(run: RunState, stageId: StageId): RunState["tasks"] {
  return run.tasks.filter((task) => taskBelongsToStage(task, stageId));
}

function taskBelongsToStage(task: RunState["tasks"][number], stageId: StageId): boolean {
  if (stageId === "plan") return true;
  if (stageId === "build") return BUILD_STAGE_STATUSES.has(task.status);
  if (stageId === "review") return Boolean(task.review || task.test) || task.status === "working";
  return ACTIVE_STAGE_STATUSES.has(task.status);
}

const BUILD_STAGE_STATUSES = new Set(["working", "reworking", "pending", "passed", "merged", "blocked"]);
const ACTIVE_STAGE_STATUSES = new Set(["working", "reworking", "blocked"]);

function visibleTasks(stageId: StageId, tasks: RunState["tasks"]): RunState["tasks"] {
  if (stageId === "plan" || stageId === "build" || stageId === "review") return tasks;
  return tasks.filter((task) => task.status !== "pending");
}

/** Running/done/failed agents for this stage, in first-seen order. */
function stageAgents(events: RunEvent[], roles: string[]): StageBrief["agents"] {
  const seen = new Map<string, StageBrief["agents"][number]>();
  for (const event of events) {
    const update = agentUpdate(event, roles);
    if (update) seen.set(update.id, update.agent);
  }
  return [...seen.values()];
}

function agentUpdate(
  event: RunEvent,
  roles: string[],
): { id: string; agent: StageBrief["agents"][number] } | undefined {
  const role = invocationRole(event);
  if (!role || !roles.includes(role)) return undefined;
  if (event.type === "agent.invocation.started") return startedAgent(event, role);
  if (event.type === "agent.invocation.completed") return finishedAgent(event, role);
  return undefined;
}

function startedAgent(
  event: RunEvent,
  role: string,
): { id: string; agent: StageBrief["agents"][number] } {
  const payload = record(event.payload);
  return {
    id: text(payload?.invocationId) ?? role,
    agent: { role, label: agentRoleLabel(role), status: "running" },
  };
}

function finishedAgent(
  event: RunEvent,
  role: string,
): { id: string; agent: StageBrief["agents"][number] } {
  const payload = record(event.payload);
  const profile = text(payload?.profile);
  return {
    id: text(payload?.invocationId) ?? role,
    agent: {
      role,
      label: agentRoleLabel(role),
      status: payload?.success === false ? "failed" : "done",
      ...(profile ? { note: profile } : {}),
    },
  };
}

export type ModuleStatus = "working" | "blocked" | "done" | "pending" | "mixed";

export interface ArchitectureModule {
  id: string;
  label: string;
  kind?: "module" | "interface" | "data";
  responsibility?: string;
  paths: string[];
  /** Directory in the repository index that covers these paths. */
  nodeId?: string;
  tasks: TaskRunState[];
  status: ModuleStatus;
}

export interface ArchitectureEdge {
  from: string;
  to: string;
  kind?: ArchitectureRelationKind;
  label?: string;
}

export const ARCHITECTURE_KIND_LABEL = { module: "模块", interface: "接口", data: "数据" } as const;
export const ARCHITECTURE_RELATION_LABEL = { calls: "调用", reads: "读取", writes: "写入", depends: "依赖" } as const;
export const ARCHITECTURE_SOURCE_LABEL: Record<ArchitectureSource, string> = {
  architect: "架构师设计",
  controller: "控制面生成",
  inferred: "由路径推断",
};

export interface ArchitectureBox extends ArchitectureModule {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ArchitectureDiagram {
  boxes: ArchitectureBox[];
  edges: ArchitectureEdge[];
  width: number;
  height: number;
}

const BOX_WIDTH = 176;
const BOX_HEIGHT = 92;
const GAP_X = 40;
const GAP_Y = 64;
const PAD = 16;

/** `src/cart/coupon.ts` becomes `src/cart`, so the diagram is a system map rather than one box per file. */
export function moduleKey(ownedPath: string): string {
  const parts = ownedPath.replace(/^\.?\//, "").split("/").filter((part) => part && !part.includes("*"));
  if (parts.length === 0) return ownedPath || "未指定";
  if (parts.length >= 2 && ["src", "web", "app"].includes(parts[0]!)) {
    return parts.slice(0, 2).join("/");
  }
  return parts[0]!;
}

function rollupStatus(tasks: TaskRunState[]): ModuleStatus {
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  if (tasks.some((task) => task.status === "working" || task.status === "reworking")) return "working";
  if (tasks.length > 0 && tasks.every((task) => task.status === "passed" || task.status === "merged")) return "done";
  if (tasks.every((task) => task.status === "pending")) return "pending";
  return "mixed";
}

function pathCovered(owned: string, elementPaths: string[]): boolean {
  const wildcard = owned.search(/[*!?{[(]/);
  const ownedPrefix = (wildcard === -1 ? owned : owned.slice(0, wildcard)).replace(/\/$/, "");
  return elementPaths.some((pattern) => {
    const mark = pattern.search(/[*!?{[(]/);
    const prefix = (mark === -1 ? pattern : pattern.slice(0, mark)).replace(/\/$/, "");
    if (!prefix) return true;
    return ownedPrefix === prefix || ownedPrefix.startsWith(`${prefix}/`);
  });
}

function layoutDiagram(modules: Map<string, ArchitectureModule>, edges: ArchitectureEdge[]): ArchitectureDiagram {
  const layers = layersOf(modules, edges);
  const boxes = placeBoxes(modules, layers);
  const width = diagramWidth(layers);
  return {
    boxes,
    edges,
    width,
    height: diagramHeight(layers),
  };
}

/** Longest-path layering: ready nodes first, cycles broken one node at a time. */
function layersOf(modules: Map<string, ArchitectureModule>, edges: ArchitectureEdge[]): string[][] {
  const incoming = incomingCounts(modules, edges);
  const remaining = new Set(modules.keys());
  const layers: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => (incoming.get(id) ?? 0) === 0).sort();
    const layer = ready.length > 0 ? ready : [...remaining].sort().slice(0, 1);
    layers.push(layer);
    for (const id of layer) {
      remaining.delete(id);
      releaseEdges(id, edges, incoming);
    }
  }
  return layers;
}

function incomingCounts(
  modules: Map<string, ArchitectureModule>,
  edges: ArchitectureEdge[],
): Map<string, number> {
  const incoming = new Map<string, number>();
  for (const id of modules.keys()) incoming.set(id, 0);
  for (const edge of edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  return incoming;
}

function releaseEdges(id: string, edges: ArchitectureEdge[], incoming: Map<string, number>): void {
  for (const edge of edges) {
    if (edge.from === id) incoming.set(edge.to, (incoming.get(edge.to) ?? 1) - 1);
  }
}

function placeBoxes(
  modules: Map<string, ArchitectureModule>,
  layers: string[][],
): ArchitectureBox[] {
  const width = diagramWidth(layers);
  const boxes: ArchitectureBox[] = [];
  layers.forEach((layer, row) => {
    const offset = Math.max(PAD, (width - rowWidth(layer)) / 2);
    layer.forEach((id, column) => {
      boxes.push({
        ...modules.get(id)!,
        x: offset + column * (BOX_WIDTH + GAP_X),
        y: PAD + row * (BOX_HEIGHT + GAP_Y),
        width: BOX_WIDTH,
        height: BOX_HEIGHT,
      });
    });
  });
  return boxes;
}

function rowWidth(layer: string[]): number {
  return layer.length * BOX_WIDTH + (layer.length - 1) * GAP_X;
}

function diagramWidth(layers: string[][]): number {
  return Math.max(...layers.map((layer) => layer.length), 1) * (BOX_WIDTH + GAP_X) - GAP_X + PAD * 2;
}

function diagramHeight(layers: string[][]): number {
  const height = layers.length * (BOX_HEIGHT + GAP_Y) - GAP_Y + PAD * 2;
  return Math.max(height, BOX_HEIGHT + PAD * 2);
}

export function buildArchitectureDiagram(tasks: TaskRunState[]): ArchitectureDiagram {
  const { modules, taskModule } = modulesFromPaths(tasks);
  for (const module of modules.values()) module.status = rollupStatus(module.tasks);
  return layoutDiagram(modules, edgesFromDependencies(tasks, taskModule));
}

/** Group tasks by the module directory of their first owned path. */
function modulesFromPaths(tasks: TaskRunState[]): {
  modules: Map<string, ArchitectureModule>;
  taskModule: Map<string, string>;
} {
  const modules = new Map<string, ArchitectureModule>();
  const taskModule = new Map<string, string>();
  for (const task of tasks) {
    const key = moduleKey(task.task.ownedPaths[0] ?? "未指定");
    taskModule.set(task.task.id, key);
    modules.set(key, addToModule(modules.get(key), key, task));
  }
  return { modules, taskModule };
}

function addToModule(
  current: ArchitectureModule | undefined,
  key: string,
  task: TaskRunState,
): ArchitectureModule {
  const module =
    current ?? { id: key, label: key, paths: [], tasks: [], status: "pending" as ModuleStatus };
  for (const owned of task.task.ownedPaths) {
    if (!module.paths.includes(owned)) module.paths.push(owned);
  }
  module.tasks.push(task);
  return module;
}

/** A dependency edge between two different modules, deduplicated. */
function edgesFromDependencies(
  tasks: TaskRunState[],
  taskModule: Map<string, string>,
): ArchitectureEdge[] {
  const seen = new Set<string>();
  const edges: ArchitectureEdge[] = [];
  for (const task of tasks) {
    const to = taskModule.get(task.task.id);
    if (!to) continue;
    for (const dependency of task.task.dependsOn) {
      addDependencyEdge(edges, seen, taskModule.get(dependency), to);
    }
  }
  return edges;
}

function addDependencyEdge(
  edges: ArchitectureEdge[],
  seen: Set<string>,
  from: string | undefined,
  to: string,
): void {
  if (!from || from === to) return;
  const key = `${from}->${to}`;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push({ from, to });
}

function diagramFromDesign(tasks: TaskRunState[], design: ArchitectureDesign): ArchitectureDiagram {
  const modules = moduleMapFromDesign(tasks, design);
  claimUnassignedTasks(tasks, design, modules);
  for (const module of modules.values()) module.status = rollupStatus(module.tasks);
  return layoutDiagram(modules, designEdges(design, modules));
}

/** Modules come from the design; tasks are attached by element id first. */
function moduleMapFromDesign(
  tasks: TaskRunState[],
  design: ArchitectureDesign,
): Map<string, ArchitectureModule> {
  const modules = new Map<string, ArchitectureModule>();
  for (const element of design.elements) {
    modules.set(element.id, {
      id: element.id,
      label: element.name,
      kind: element.kind,
      responsibility: element.responsibility,
      paths: [...element.paths],
      ...(element.nodeId ? { nodeId: element.nodeId } : {}),
      tasks: tasks.filter((task) => task.task.elementId === element.id),
      status: "pending",
    });
  }
  return modules;
}

/** Elements with no explicit task still own the tasks whose paths they cover. */
function claimUnassignedTasks(
  tasks: TaskRunState[],
  design: ArchitectureDesign,
  modules: Map<string, ArchitectureModule>,
): void {
  const claimed = new Set<string>();
  for (const module of modules.values()) {
    for (const task of module.tasks) claimed.add(task.task.id);
  }
  for (const element of design.elements) {
    const module = modules.get(element.id)!;
    if (module.tasks.length > 0) continue;
    module.tasks = tasks.filter(
      (task) => !claimed.has(task.task.id) && task.task.ownedPaths.every((owned) => pathCovered(owned, element.paths)),
    );
    for (const task of module.tasks) claimed.add(task.task.id);
  }
}

function designEdges(
  design: ArchitectureDesign,
  modules: Map<string, ArchitectureModule>,
): ArchitectureEdge[] {
  return design.relations
    .filter((relation) => modules.has(relation.from) && modules.has(relation.to))
    .map((relation) => ({
      from: relation.from,
      to: relation.to,
      kind: relation.kind,
      ...(relation.label ? { label: relation.label } : {}),
    }));
}

export interface ArchitecturePresentation {
  diagram: ArchitectureDiagram;
  source: ArchitectureSource;
  summary?: string;
  sequence: ArchitectureDesign["sequence"];
}

/** Prefer the stored design. Without one, the path collage is an inference. */
export function presentArchitecture(tasks: TaskRunState[], design?: ArchitectureDesign): ArchitecturePresentation {
  if (!design) {
    const diagram = buildArchitectureDiagram(tasks);
    return {
      diagram,
      source: "inferred",
      sequence: diagram.edges.map((edge, index) => ({
        order: index + 1,
        from: edge.from,
        to: edge.to,
        action: "交接",
      })),
    };
  }
  return {
    diagram: diagramFromDesign(tasks, design),
    source: design.source,
    summary: design.summary,
    sequence: design.sequence,
  };
}

export function stageForTask(task: TaskRunState): StageId {
  if (task.status === "blocked") return task.review || task.test ? "review" : "build";
  if (task.status === "working" || task.status === "reworking") return "build";
  return settledStage(task);
}

function settledStage(task: TaskRunState): StageId {
  if (task.review || task.test) return "review";
  if (task.status === "merged" || task.status === "passed") return "integrate";
  return "plan";
}

export function currentStageId(run: Pick<RunState, "status" | "history">): StageId | undefined {
  return deriveStages(run).find((stage) => stage.state === "current" || stage.state === "failed")?.id;
}
