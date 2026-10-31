import type {
  LiveAgent,
  RunEvent,
  RunState,
  RunStatus,
  RunSummary,
  StrategyDefinition,
  Task,
  TaskStatus,
} from "../types";
import {
  buildDemoRuns,
  buildEvidence,
  buildExperience,
  buildUsage,
  demoConfig,
  demoDesktopSettings,
  demoEvolution,
  demoWorkspace,
  iso,
  type DemoRun,
} from "./seed";
import { demoExplanation, demoReplay, demoTaskDiff, demoTranscript, demoTranscripts, demoUsageBreakdown } from "./insights";

type Listener = (event: RunEvent) => void;

const minute = 60_000;
const TICK_MS = 1_600;

const stdoutScript = [
  "$ pnpm exec vitest run src/export/csv.test.ts",
  " ✓ 转义逗号、引号与换行",
  " ✓ 时间范围筛选包含边界",
  "写入 src/export/csv.ts …",
  "$ pnpm check",
  "类型检查通过，0 个错误",
  "提交到分支 agent/task-csv",
];

function summarize(state: RunState): RunSummary {
  const counts: Record<TaskStatus, number> = { pending: 0, working: 0, reworking: 0, passed: 0, merged: 0, blocked: 0 };
  for (const item of state.tasks) counts[item.status] += 1;
  return {
    id: state.id,
    goal: state.goal,
    status: state.status,
    strategy: state.strategy.name,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    taskCounts: counts,
    ...(state.error ? { error: state.error } : {}),
    ...(state.parentRunId ? { parentRunId: state.parentRunId } : {}),
  };
}

const DEFAULT_STRATEGY = "balanced";

function withDefault<T>(value: T | undefined, fallback: T): T {
  return value ?? fallback;
}

const RUN_LIMITS = {
  executionTimeoutSeconds: 900,
  maxAgentInvocations: 64,
  maxProcessOutputBytes: 4_000_000,
  maxArtifactBytes: 8_000_000,
  approvalTimeoutSeconds: 3600,
} as const;

function strategyDefinition(name: string): StrategyDefinition {
  const definitions = demoConfig.strategies.definitions;
  return definitions[name] ?? definitions[DEFAULT_STRATEGY]!;
}

function newRunState(id: string, goal: string, strategy: string | undefined): RunState {
  const name = strategy ?? DEFAULT_STRATEGY;
  const def = strategyDefinition(name);
  const now = new Date().toISOString();
  return {
    id,
    goal,
    status: "created",
    strategy: {
      name,
      maxParallel: withDefault(def.maxParallel, 3),
      maxReworkAttempts: withDefault(def.maxReworkAttempts, 2),
      ...RUN_LIMITS,
      roleProfiles: def.roleProfiles,
      approvalGates: withDefault(def.approvalGates, ["final"]),
      topology: def.compiledTopology,
    },
    profileOverrides: {},
    createdAt: now,
    updatedAt: now,
    tasks: [],
    history: [{ at: now, status: "created", message: "运行已创建" }],
  };
}

function initialRuns(base: number): Map<string, DemoRun[]> {
  return new Map([
    ["storefront", buildDemoRuns(base)],
    ["docs-site", []],
  ]);
}

function delivers(
  entry: { project: string; runId: string | undefined },
  project: string,
  run: DemoRun,
): boolean {
  if (entry.project !== project) return false;
  return entry.runId === undefined || entry.runId === run.state.id;
}

function nextEvent(run: DemoRun, type: string, payload: unknown): RunEvent {
  const sequence = (run.events.at(-1)?.sequence ?? 0) + 1;
  return {
    sequence,
    id: `${run.state.id}-${sequence}`,
    schemaVersion: 1,
    runId: run.state.id,
    type,
    occurredAt: new Date().toISOString(),
    payload,
    traceId: "a".repeat(32),
    spanId: sequence.toString(16).padStart(16, "0"),
  };
}

export class DemoServer {
  readonly base = Date.now();
  private readonly runs = initialRuns(this.base);
  private readonly listeners = new Set<{ project: string; runId: string | undefined; fn: Listener }>();
  private tick = 0;

  constructor() {
    window.setInterval(() => this.stream(), TICK_MS);
  }

  list(project: string): DemoRun[] {
    let runs = this.runs.get(project);
    if (!runs) {
      runs = [];
      this.runs.set(project, runs);
    }
    return runs;
  }

  find(project: string, runId: string): DemoRun | undefined {
    return this.list(project).find((entry) => entry.state.id === runId);
  }

  subscribe(project: string, runId: string | undefined, fn: Listener): () => void {
    const entry = { project, runId, fn };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  replay(project: string, runId: string): RunEvent[] {
    return this.find(project, runId)?.events ?? [];
  }

  emit(project: string, run: DemoRun, type: string, payload: unknown): void {
    const event = nextEvent(run, type, payload);
    run.events.push(event);
    for (const entry of this.listeners) {
      if (delivers(entry, project, run)) entry.fn(event);
    }
  }

  touch(project: string, run: DemoRun, status?: RunStatus, message?: string): void {
    const now = new Date().toISOString();
    run.state.updatedAt = now;
    if (status && status !== run.state.status) {
      run.state.status = status;
      run.state.history.push({ at: now, status, message: message ?? status });
    }
    this.emit(project, run, "run.updated", { status: run.state.status });
  }

  /** The seeded "running" run keeps printing output so the live view is not static. */
  private stream(): void {
    const project = "storefront";
    const run = this.find(project, "demo-running");
    if (!run || run.state.status !== "implementing") return;
    this.tick += 1;
    const working = run.state.tasks.filter((item) => item.status === "working");
    if (working.length === 0) return;
    const line = stdoutScript[this.tick % stdoutScript.length]!;
    const index = run.state.tasks.indexOf(working[this.tick % working.length]!);
    this.emit(project, run, "agent.stdout", {
      invocationId: `demo-running-w${index}`,
      role: "worker",
      artifactKey: `demo-w${index}`,
      text: `${line}\n`,
      chunk: `${line}\n`,
    });
    if (this.tick % 14 === 0) {
      const item = working[0]!;
      item.status = "passed";
      item.commit = "b7e41cd";
      this.emit(project, run, "run.wave.completed", { taskIds: [item.task.id], status: "passed" });
      this.touch(project, run);
    }
  }

  createRun(project: string, goal: string, strategy: string | undefined): string {
    const id = `demo-new-${Math.random().toString(36).slice(2, 8)}`;
    const state = newRunState(id, goal, strategy);
    const run: DemoRun = { state, events: [], diff: "", changedFiles: [] };
    this.list(project).unshift(run);
    this.emit(project, run, "run.updated", { status: "created" });
    this.script(project, run);
    return id;
  }

  /** A short scripted lifecycle for runs started from the demo UI. */
  private script(project: string, run: DemoRun): void {
    const steps: Array<[number, () => void]> = [
      [900, () => this.touch(project, run, "orchestrating", "总控分析目标")],
      [2_400, () => this.touch(project, run, "architecting", "架构拆分任务")],
      [4_200, () => {
        const tasks: Task[] = ["梳理现有实现", "实现核心改动", "补充测试"].map((title, index) => ({
          id: `task-${index + 1}`,
          title,
          description: title,
          dependsOn: index === 0 ? [] : [`task-${index}`],
          ownedPaths: [],
          acceptanceCommands: [{ command: "pnpm", args: ["test", "--run"] }],
          profile: null,
        }));
        run.state.plan = { summary: "按依赖顺序串行推进三个任务。", tasks };
        run.state.tasks = tasks.map((task, index) => ({ task, status: index === 0 ? "working" : "pending", attempts: index === 0 ? 1 : 0 }));
        this.touch(project, run, "implementing", "开始实现");
      }],
      [7_000, () => {
        for (const item of run.state.tasks) {
          item.status = "merged";
          item.attempts = Math.max(1, item.attempts);
        }
        this.touch(project, run, "final-checks", "运行质量门");
      }],
      [9_000, () => {
        run.state.finalQuality = { passed: true };
        run.state.finalDecision = { decision: "ready", reason: "演示运行：确定性检查通过。" };
        run.state.approvals = [{
          id: `approval-${run.state.id}`,
          gate: "final",
          status: "pending",
          summary: "演示运行完成，等待你确认。",
          checkpointId: "checkpoint-demo",
          requestedAt: new Date().toISOString(),
          expiresAt: iso(60 * minute, Date.now()),
        }];
        this.emit(project, run, "approval.requested", { gate: "final", requestId: `approval-${run.state.id}` });
        this.touch(project, run, "awaiting-human", "等待最终审批");
      }],
    ];
    for (const [delay, step] of steps) window.setTimeout(step, delay);
  }

  demoAgents(run: DemoRun): LiveAgent[] {
    const now = new Date().toISOString();
    return run.state.tasks.flatMap((item, index) =>
      item.status === "working"
        ? [{
            id: `demo-agent-${item.task.id}`,
            runId: run.state.id,
            role: "worker",
            artifactKey: `demo-w${index}`,
            taskId: item.task.id,
            profile: "codex-worker",
            adapter: "codex",
            model: "gpt-5",
            kind: "codex-app-server" as const,
            capabilities: { steer: true, interrupt: true, askUser: true, resume: false },
            startedAt: now,
            lastActivityAt: now,
            status: "running" as const,
            questions: [],
          }]
        : [],
    );
  }

  act(project: string, runId: string, action: string, body: Record<string, unknown>): unknown {
    const run = this.find(project, runId);
    if (!run) return undefined;
    const handler = ACTIONS[action];
    return handler ? handler(this, project, runId, run, body) : undefined;
  }

  handle(method: string, rawPath: string, body: Record<string, unknown>): { status: number; body: unknown } {
    const { project, path } = parsePath(rawPath);
    return (
      platformResponse(path, project) ??
      projectResponse(this, method, path, project, body) ??
      runResponse(this, method, path, project, rawPath, body) ??
      NOT_SUPPORTED
    );
  }
}

interface DemoResponse {
  status: number;
  body: unknown;
}

const NOT_SUPPORTED: DemoResponse = { status: 404, body: { error: "演示模式不支持该操作" } };

function ok(payload: unknown): DemoResponse {
  return { status: 200, body: payload };
}

/** `/api/projects/<project>/<path>` with the default project as fallback. */
function parsePath(rawPath: string): { project: string; path: string } {
  const scoped = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(rawPath);
  if (!scoped) return { project: "storefront", path: rawPath.replace(/^\/api/, "").split("?")[0]! };
  return {
    project: decodeURIComponent(scoped[1]!),
    path: (scoped[2] ?? "").split("?")[0]!,
  };
}

/** Endpoints that do not depend on the selected project's runs. */
function platformResponse(path: string, project: string): DemoResponse | undefined {
  if (path === "/workspace") return ok(demoWorkspace);
  if (path === "/config") return ok(demoConfig);
  if (path === "/desktop/settings") return ok(demoDesktopSettings);
  if (path.startsWith("/desktop/cli-inventory")) {
    return ok({ inventory: demoDesktopSettings.inventory, fromCache: true });
  }
  if (path === "/evolution") return ok(demoEvolution);
  if (path === "/jev/probe") return ok({ ok: false, latencyMs: 0, error: "演示模式不连接本地模型" });
  if (path === "/onboarding" || path === "/onboarding/quality") return ok(demoOnboarding(project));
  if (path === "/role-settings") return ok(roleSettings(project));
  return undefined;
}

function roleSettings(project: string): unknown {
  const roles = demoDesktopSettings.settings.defaults.roles;
  return {
    projectId: project,
    projectName: project,
    roles: {},
    global: roles,
    effective: roles,
    sources: {},
  };
}

/** Endpoints scoped to the project's run collection. */
function projectResponse(
  server: DemoServer,
  method: string,
  path: string,
  project: string,
  body: Record<string, unknown>,
): DemoResponse | undefined {
  const runs = server.list(project);
  if (path === "/experience") return ok(buildExperience(server.base));
  if (path === "/experience/retrieve") return ok({ note: "演示数据", items: [] });
  if (path === "/usage") return ok(buildUsage(runs));
  if (path === "/runs") return runsResponse(server, method, project, runs, body);
  if (path === "/runs/cleanup/preview") return ok(cleanupPreview(runs, body));
  if (path === "/runs/cleanup") return ok({ deletedRunIds: [], reclaimedBytes: 0 });
  return undefined;
}

function runsResponse(
  server: DemoServer,
  method: string,
  project: string,
  runs: DemoRun[],
  body: Record<string, unknown>,
): DemoResponse {
  if (method === "GET") return ok({ runs: runs.map((entry) => summarize(entry.state)) });
  return ok({
    runId: server.createRun(
      project,
      String(body.goal ?? "演示运行"),
      typeof body.strategy === "string" ? body.strategy : undefined,
    ),
  });
}

function cleanupPreview(runs: DemoRun[], body: Record<string, unknown>): unknown {
  const candidates = runs
    .filter((entry) => ["completed", "cancelled", "blocked", "interrupted"].includes(entry.state.status))
    .map((entry) => ({
      id: entry.state.id,
      goal: entry.state.goal,
      status: entry.state.status as "completed",
      updatedAt: entry.state.updatedAt,
      bytes: CLEANUP_BYTES,
    }));
  return {
    token: "demo-token",
    expiresAt: iso(10 * minute, Date.now()),
    olderThanDays: Number(body.olderThanDays ?? 7),
    cutoff: new Date().toISOString(),
    candidates,
    totalBytes: candidates.length * CLEANUP_BYTES,
  };
}

const CLEANUP_BYTES = 120_000;

/** `/runs/<id>/<rest>` — one run's detail endpoints. */
function runResponse(
  server: DemoServer,
  method: string,
  path: string,
  project: string,
  rawPath: string,
  body: Record<string, unknown>,
): DemoResponse | undefined {
  const match = /^\/runs\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!match) return undefined;
  const runId = decodeURIComponent(match[1]!);
  const run = server.find(project, runId);
  if (!run) return { status: 404, body: { error: "运行不存在" } };
  const rest = match[2];
  if (!rest) return ok({ run: run.state });
  return entityResponse({ server, method, project, runId, run, rest, rawPath, body });
}

interface EntityContext {
  server: DemoServer;
  method: string;
  project: string;
  runId: string;
  run: DemoRun;
  rest: string;
  rawPath: string;
  body: Record<string, unknown>;
}

const RUN_ENTITIES: Record<string, (ctx: EntityContext) => DemoResponse> = {
  evidence: ({ run }) => ok({ evidence: buildEvidence(run) }),
  "evidence/file": () => ok({ file: EVIDENCE_FILE }),
  export: () => ok({}),
  agents: (ctx) => ok({ agents: ctx.server.demoAgents(ctx.run) }),
  explain: ({ run }) => ok({ explanation: demoExplanation(run) }),
  usage: ({ run }) => ok({ usage: demoUsageBreakdown(run) }),
  replay: ({ run }) => ok({ steps: demoReplay(run) }),
  transcripts: ({ run }) => ok({ transcripts: demoTranscripts(run) }),
};

const EVIDENCE_FILE = {
  path: "plan/architect-output.md",
  size: 120,
  content: "# 演示产物\n\n这是演示数据，不对应真实文件。\n",
  truncated: false,
};

function entityResponse(ctx: EntityContext): DemoResponse {
  const handler = RUN_ENTITIES[ctx.rest];
  if (handler) return handler(ctx);
  if (ctx.rest === "transcript") return ok({ transcript: demoTranscript(transcriptId(ctx.rawPath)) });
  const taskDiff = /^tasks\/([^/]+)\/diff$/.exec(ctx.rest);
  if (taskDiff) return ok({ diff: demoTaskDiff(ctx.run, decodeURIComponent(taskDiff[1]!)) });
  const agentAction = /^agents\/([^/]+)\/(steer|interrupt|answer)$/.exec(ctx.rest);
  if (agentAction && ctx.method === "POST") return ok(agentEvent(ctx, agentAction));
  const action = /^actions\/(.+)$/.exec(ctx.rest);
  if (!action || ctx.method !== "POST") return NOT_SUPPORTED;
  const result = ctx.server.act(ctx.project, ctx.runId, action[1]!, ctx.body);
  return result === undefined ? NOT_SUPPORTED : ok(result);
}

function transcriptId(rawPath: string): string {
  return new URLSearchParams(rawPath.split("?")[1] ?? "").get("id") ?? "";
}

function agentEvent(ctx: EntityContext, match: RegExpExecArray): unknown {
  const agentId = decodeURIComponent(match[1]!);
  const actor = String(ctx.body.actor ?? "demo");
  const server = ctx.server;
  if (match[2] === "steer") {
    server.emit(ctx.project, ctx.run, "agent.steered", { agentId, actor, text: ctx.body.text });
  } else if (match[2] === "interrupt") {
    server.emit(ctx.project, ctx.run, "agent.interrupted", {
      agentId,
      actor,
      note: ctx.body.note,
      redirected: ctx.body.note !== undefined,
    });
  } else {
    server.emit(ctx.project, ctx.run, "agent.answered", {
      agentId,
      actor,
      questionId: ctx.body.questionId,
      answer: ctx.body.answer,
    });
  }
  return { ok: true };
}

type ActionHandler = (
  server: DemoServer,
  project: string,
  runId: string,
  run: DemoRun,
  body: Record<string, unknown>,
) => unknown;

const ACTIONS: Record<string, ActionHandler> = {
  "respond-approval": (server, project, _runId, run, body) => respondApproval(server, project, run, body),
  pause: (server, project, _runId, run) => {
    server.touch(project, run, "interrupted", "已暂停");
    return {};
  },
  cancel: (server, project, _runId, run) => {
    server.touch(project, run, "cancelled", "已取消");
    return {};
  },
  resume: (server, project, _runId, run) => {
    server.touch(project, run, "implementing", "从检查点继续");
    return {};
  },
  publish: (server, project, _runId, run) => publish(server, project, run),
  retry: (server, project, _runId, run) => ({
    runId: server.createRun(project, run.state.goal, run.state.strategy.name),
  }),
  delete: (server, project, runId, run) => deleteRun(server, project, runId, run),
};

function respondApproval(
  server: DemoServer,
  project: string,
  run: DemoRun,
  body: Record<string, unknown>,
): unknown {
  const approval = run.state.approvals?.find((item) => item.id === body.requestId);
  const approved = body.decision === "approved";
  if (approval) {
    const decision = approved ? "approved" : "rejected";
    approval.status = decision;
    approval.response = {
      decision,
      actor: String(body.actor ?? "demo"),
      reason: String(body.reason ?? ""),
      respondedAt: new Date().toISOString(),
    };
    server.emit(project, run, "approval.responded", {
      gate: approval.gate,
      decision,
      reason: body.reason,
    });
  }
  server.touch(project, run, approved ? "ready-to-merge" : "blocked", approved ? "审批通过" : "审批驳回");
  return {};
}

function publish(server: DemoServer, project: string, run: DemoRun): unknown {
  run.state.pullRequestUrl = "https://example.com/storefront/pull/200";
  run.state.pullRequestNumber = 200;
  server.touch(project, run, "completed", "已发布");
  return { runId: run.state.id, status: "completed", pullRequestUrl: run.state.pullRequestUrl };
}

function deleteRun(server: DemoServer, project: string, runId: string, run: DemoRun): unknown {
  const runs = server.list(project);
  runs.splice(runs.indexOf(run), 1);
  return { deletedRunIds: [runId], reclaimedBytes: 0 };
}

/** `/api/projects/<project>/…?runId=…`, defaulting to the demo project. */
function parseStreamUrl(url: string): { project: string; runId: string | undefined } {
  const parsed = new URL(url, window.location.origin);
  const scoped = /^\/api\/projects\/([^/]+)/.exec(parsed.pathname);
  return {
    project: scoped ? decodeURIComponent(scoped[1]!) : "storefront",
    runId: parsed.searchParams.get("runId") ?? undefined,
  };
}

class DemoEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  private off: (() => void) | undefined;

  constructor(readonly url: string, server: DemoServer) {
    const { project, runId } = parseStreamUrl(url);
    window.setTimeout(() => {
      if (this.readyState === 2) return;
      this.readyState = 1;
      this.onopen?.(new Event("open"));
      if (runId) for (const event of server.replay(project, runId)) this.deliver(event);
      this.off = server.subscribe(project, runId, (event) => this.deliver(event));
    }, 30);
  }

  private deliver(event: RunEvent): void {
    if (this.readyState !== 1) return;
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
  }

  close(): void {
    this.readyState = 2;
    this.off?.();
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

export function installDemoMode(): void {
  const server = new DemoServer();
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => demoFetch(server, nativeFetch, input, init);
  class BoundEventSource extends DemoEventSource {
    constructor(url: string) {
      super(url, server);
    }
  }
  (window as unknown as { EventSource: unknown }).EventSource = BoundEventSource;
}

async function demoFetch(
  server: DemoServer,
  nativeFetch: typeof window.fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Response> {
  const path = requestPath(input);
  if (!path.startsWith("/api")) return nativeFetch(input, init);
  await new Promise((resolve) => window.setTimeout(resolve, 60));
  const result = server.handle((init?.method ?? "GET").toUpperCase(), path, requestBody(init));
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === "string") return absolutePath(input);
  return input instanceof URL ? input.pathname + input.search : input.url;
}

function absolutePath(url: string): string {
  if (!url.startsWith("http")) return url;
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string" || !init.body) return {};
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function demoOnboarding(project: string) {
  const firstRun = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("onboarding") === "1";
  return {
    projectId: project,
    projectName: project,
    source: firstRun ? ("detected" as const) : ("file" as const),
    configPath: "agent-team.yaml",
    needsSetup: firstRun,
    detection: {
      root: "/demo",
      name: project,
      isGitRepo: true,
      defaultBranch: "main",
      ecosystems: ["node"],
      packageManager: "pnpm",
      commands: [
        { role: "typecheck" as const, label: "pnpm run check", command: { command: "pnpm", args: ["run", "check"] }, source: "package.json scripts.check", selected: true },
        { role: "test" as const, label: "pnpm run test", command: { command: "pnpm", args: ["run", "test"] }, source: "package.json scripts.test", selected: true },
      ],
    },
    current: { commands: [{ command: "pnpm", args: ["run", "test"] }] },
    clis: [{ id: "codex", installed: true, runtimeSupported: true, version: "demo", authStatus: "present" as const }],
    recommendedCli: "codex",
  };
}
