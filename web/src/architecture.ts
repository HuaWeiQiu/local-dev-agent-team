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
    const payload = record(event.payload);
    const id = text(payload?.invocationId);
    const role = invocationRole(event);
    if (event.type === "agent.invocation.started" && id && role && wanted.has(role)) live.add(id);
    if (event.type === "agent.invocation.completed" && id) live.delete(id);
    if ((event.type === "agent.stdout" || event.type === "agent.stderr") && id && live.has(id)) {
      const chunk = text(payload?.text);
      if (chunk) latest = chunk.trim();
    }
  }
  return latest;
}

function stageArtifact(run: RunState, stageId: StageId): StageArtifact | undefined {
  if (stageId === "intake" && run.intake) {
    return { title: "目标理解", body: run.intake.goalSummary };
  }
  if (stageId === "explore" && run.explore) {
    const lines = [
      run.explore.summary,
      run.explore.modules.length > 0 ? `模块：${run.explore.modules.join("、")}` : "",
      run.explore.riskPaths.length > 0 ? `风险路径：${run.explore.riskPaths.join("、")}` : "",
    ].filter(Boolean);
    return { title: "探索摘要", body: lines.join("\n") };
  }
  if (stageId === "plan" && run.plan) {
    const design = run.plan.design;
    if (design) {
      const title = design.source === "architect" ? "架构设计" : design.source === "controller" ? "控制面设计" : "推断出的结构";
      return {
        title,
        body: [design.summary, ...design.elements.map((element) => `${element.name}：${element.responsibility}`)].join("\n"),
      };
    }
    return { title: "任务计划", body: run.plan.summary };
  }
  if (stageId === "gates" && run.finalQuality) {
    return { title: "质量报告", body: run.finalQuality.passed ? "确定性检查通过。" : "确定性检查未通过。" };
  }
  if ((stageId === "approval" || stageId === "ship") && run.finalDecision) {
    return { title: "最终决定", body: run.finalDecision.reason };
  }
  return undefined;
}

const STAGE_EVENT_TYPES: Partial<Record<StageId, string[]>> = {
  build: ["run.wave.started", "run.wave.completed"],
  review: ["run.advisor.consulted", "flow.triage", "quality.flaky"],
  approval: ["approval.requested", "approval.resolved"],
  gates: ["quality.flaky"],
  ship: ["run.updated"],
};

function stageInput(run: RunState, stageId: StageId): string | undefined {
  if (stageId === "intake") return run.goal;
  if (stageId === "explore") return run.intake?.instructionsForArchitect ?? run.goal;
  if (stageId === "plan") return run.explore?.summary ?? run.intake?.goalSummary ?? run.goal;
  if (stageId === "build" || stageId === "review" || stageId === "integrate") {
    const titles = run.tasks.filter((task) => task.status !== "pending").map((task) => task.task.title);
    return titles.length > 0 ? titles.join("\n") : undefined;
  }
  if (stageId === "gates") {
    const commands = run.finalQuality?.commands?.map((command) => [command.spec.command, ...command.spec.args].join(" "));
    return commands && commands.length > 0 ? commands.join("\n") : undefined;
  }
  if (stageId === "approval") {
    return run.approvals?.find((approval) => approval.status === "pending")?.summary ?? run.finalDecision?.reason;
  }
  if (stageId === "ship") return run.pullRequestUrl ?? run.finalDecision?.reason;
  return undefined;
}

function stageRetries(run: RunState, stageId: StageId, events: RunEvent[]): number {
  if (stageId !== "build" && stageId !== "review") return 0;
  const attempts = run.tasks.reduce((total, task) => total + Math.max(0, task.attempts - 1) + (task.quality?.reruns ?? 0), 0);
  const signals = events.filter((event) => event.type === "quality.flaky" || event.type === "flow.triage").length;
  return attempts + signals;
}

function ledgerDetail(event: RunEvent): { label: string; detail?: string } {
  const payload = record(event.payload);
  const role = text(payload?.role);
  const roleLabel = role ? agentRoleLabel(role) : "智能体";
  if (event.type === "agent.invocation.started") {
    const profile = text(payload?.profile);
    return { label: `${roleLabel} 开始`, ...(profile ? { detail: profile } : {}) };
  }
  if (event.type === "agent.invocation.completed") {
    const profile = text(payload?.profile);
    return {
      label: `${roleLabel} ${payload?.success === false ? "失败" : "完成"}`,
      ...(profile ? { detail: profile } : {}),
    };
  }
  if (event.type === "agent.stdout" || event.type === "agent.stderr") {
    const chunk = text(payload?.text)?.replace(/\s+/g, " ").slice(0, 160);
    return { label: event.type === "agent.stderr" ? "错误输出" : "输出", ...(chunk ? { detail: chunk } : {}) };
  }
  if (event.type === "run.wave.started" || event.type === "run.wave.completed") {
    const ids = Array.isArray(payload?.taskIds) ? payload.taskIds.filter((id): id is string => typeof id === "string") : [];
    const status = text(payload?.status);
    const detail = [ids.join("、"), status].filter(Boolean).join(" · ");
    return { label: event.type === "run.wave.started" ? "开始一批任务" : "这一批结束", ...(detail ? { detail } : {}) };
  }
  if (event.type === "run.advisor.consulted" || event.type === "flow.triage") {
    const summary = text(payload?.summary) ?? text(payload?.recommendation);
    return { label: "重试或请教", ...(summary ? { detail: summary } : {}) };
  }
  if (event.type === "quality.flaky") return { label: "不稳定命令重跑" };
  if (event.type === "approval.requested" || event.type === "approval.resolved") {
    const gate = text(payload?.gate);
    return { label: event.type === "approval.requested" ? "请求审批" : "审批结果", ...(gate ? { detail: gate } : {}) };
  }
  return { label: event.type };
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
  const stage = deriveStages(run).find((item) => item.id === stageId) ?? {
    id: stageId,
    label: stageDefinitions.find((item) => item.id === stageId)?.label ?? stageId,
    state: "pending" as StageState,
  };
  const statuses = new Set(statusesOf(stageId));
  const history = run.history
    .filter((entry) => statuses.has(entry.status))
    .map((entry) => ({ at: entry.at, message: entry.message }))
    .slice(-6);
  const roles = STAGE_ROLES[stageId];
  const agents: StageBrief["agents"] = [];
  const seen = new Map<string, StageBrief["agents"][number]>();
  for (const event of events) {
    const role = invocationRole(event);
    if (!role || !roles.includes(role)) continue;
    const payload = record(event.payload);
    const id = text(payload?.invocationId) ?? role;
    if (event.type === "agent.invocation.started") {
      seen.set(id, { role, label: agentRoleLabel(role), status: "running" });
    } else if (event.type === "agent.invocation.completed") {
      const profile = text(payload?.profile);
      seen.set(id, {
        role,
        label: agentRoleLabel(role),
        status: payload?.success === false ? "failed" : "done",
        ...(profile ? { note: profile } : {}),
      });
    }
  }
  agents.push(...seen.values());
  const tasks = run.tasks.filter((task) => {
    if (stageId === "build") return ["working", "reworking", "pending", "passed", "merged", "blocked"].includes(task.status);
    if (stageId === "review") return Boolean(task.review || task.test) || task.status === "working";
    if (stageId === "plan") return true;
    return ["working", "reworking", "blocked"].includes(task.status);
  });
  const liveText = lastStdout(events, roles);
  const artifact = stageArtifact(run, stageId);
  const input = stageInput(run, stageId);
  const retries = stageRetries(run, stageId, events);
  const ledger = stageLedger(events, stageId, roles);
  const latest = history.at(-1)?.message;
  const headline =
    stage.state === "current"
      ? latest ?? `正在${stage.label}`
      : stage.state === "failed"
        ? latest ?? `${stage.label}在此停止`
        : stage.state === "done"
          ? latest ?? `${stage.label}已完成`
          : stage.state === "skipped"
            ? `${stage.label}已跳过`
            : `尚未开始${stage.label}`;
  return {
    stage,
    headline,
    hint: STAGE_HINT[stageId],
    history,
    agents,
    ...(liveText ? { liveText } : {}),
    ...(artifact ? { artifact } : {}),
    ...(input ? { input } : {}),
    ...(retries > 0 ? { retries } : {}),
    ledger,
    tasks: stageId === "plan" || stageId === "build" || stageId === "review" ? tasks : tasks.filter((task) => task.status !== "pending"),
  };
}

export type ModuleStatus = "working" | "blocked" | "done" | "pending" | "mixed";

export interface ArchitectureModule {
  id: string;
  label: string;
  kind?: "module" | "interface" | "data";
  responsibility?: string;
  paths: string[];
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
  const incoming = new Map<string, number>();
  for (const id of modules.keys()) incoming.set(id, 0);
  for (const edge of edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  const remaining = new Set(modules.keys());
  const layers: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => (incoming.get(id) ?? 0) === 0).sort();
    const layer = ready.length > 0 ? ready : [...remaining].sort().slice(0, 1);
    layers.push(layer);
    for (const id of layer) {
      remaining.delete(id);
      for (const edge of edges) {
        if (edge.from === id) incoming.set(edge.to, (incoming.get(edge.to) ?? 1) - 1);
      }
    }
  }

  const width = Math.max(...layers.map((layer) => layer.length), 1) * (BOX_WIDTH + GAP_X) - GAP_X + PAD * 2;
  const boxes: ArchitectureBox[] = [];
  layers.forEach((layer, row) => {
    const rowWidth = layer.length * BOX_WIDTH + (layer.length - 1) * GAP_X;
    const offset = Math.max(PAD, (width - rowWidth) / 2);
    layer.forEach((id, column) => {
      const module = modules.get(id)!;
      boxes.push({
        ...module,
        x: offset + column * (BOX_WIDTH + GAP_X),
        y: PAD + row * (BOX_HEIGHT + GAP_Y),
        width: BOX_WIDTH,
        height: BOX_HEIGHT,
      });
    });
  });
  const height = layers.length * (BOX_HEIGHT + GAP_Y) - GAP_Y + PAD * 2;
  return { boxes, edges, width, height: Math.max(height, BOX_HEIGHT + PAD * 2) };
}

/**
 * Path-prefix fallback for runs that never stored a design. The UI must label
 * this as inferred: it is not something the architect produced.
 */
export function buildArchitectureDiagram(tasks: TaskRunState[]): ArchitectureDiagram {
  const modules = new Map<string, ArchitectureModule>();
  const taskModule = new Map<string, string>();
  for (const task of tasks) {
    const key = moduleKey(task.task.ownedPaths[0] ?? "未指定");
    taskModule.set(task.task.id, key);
    const current = modules.get(key) ?? { id: key, label: key, paths: [], tasks: [], status: "pending" as ModuleStatus };
    for (const owned of task.task.ownedPaths) {
      if (!current.paths.includes(owned)) current.paths.push(owned);
    }
    current.tasks.push(task);
    modules.set(key, current);
  }
  for (const module of modules.values()) module.status = rollupStatus(module.tasks);

  const edgeSet = new Set<string>();
  const edges: ArchitectureEdge[] = [];
  for (const task of tasks) {
    const to = taskModule.get(task.task.id);
    if (!to) continue;
    for (const dependency of task.task.dependsOn) {
      const from = taskModule.get(dependency);
      if (!from || from === to) continue;
      const key = `${from}->${to}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({ from, to });
    }
  }
  return layoutDiagram(modules, edges);
}

function diagramFromDesign(tasks: TaskRunState[], design: ArchitectureDesign): ArchitectureDiagram {
  const claimed = new Set<string>();
  const modules = new Map<string, ArchitectureModule>();
  for (const element of design.elements) {
    const mine = tasks.filter((task) => task.task.elementId === element.id);
    for (const task of mine) claimed.add(task.task.id);
    modules.set(element.id, {
      id: element.id,
      label: element.name,
      kind: element.kind,
      responsibility: element.responsibility,
      paths: [...element.paths],
      tasks: mine,
      status: "pending",
    });
  }
  for (const element of design.elements) {
    const module = modules.get(element.id)!;
    if (module.tasks.length > 0) continue;
    module.tasks = tasks.filter(
      (task) => !claimed.has(task.task.id) && task.task.ownedPaths.every((owned) => pathCovered(owned, element.paths)),
    );
    for (const task of module.tasks) claimed.add(task.task.id);
  }
  for (const module of modules.values()) module.status = rollupStatus(module.tasks);
  const edges: ArchitectureEdge[] = design.relations
    .filter((relation) => modules.has(relation.from) && modules.has(relation.to))
    .map((relation) => ({
      from: relation.from,
      to: relation.to,
      kind: relation.kind,
      ...(relation.label ? { label: relation.label } : {}),
    }));
  return layoutDiagram(modules, edges);
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
  if (task.review || task.test) return "review";
  if (task.status === "merged" || task.status === "passed") return "integrate";
  return "plan";
}

export function currentStageId(run: Pick<RunState, "status" | "history">): StageId | undefined {
  return deriveStages(run).find((stage) => stage.state === "current" || stage.state === "failed")?.id;
}
