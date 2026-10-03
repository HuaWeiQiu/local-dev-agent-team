import type { LiveAgent, RunEvent, RunState, RunStatus, RunSummary, Task, TaskStatus } from "../types";
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

class DemoServer {
  private readonly base = Date.now();
  private readonly runs = new Map<string, DemoRun[]>([
    ["storefront", buildDemoRuns(this.base)],
    ["docs-site", []],
  ]);
  private readonly listeners = new Set<{ project: string; runId: string | undefined; fn: Listener }>();
  private tick = 0;

  constructor() {
    window.setInterval(() => this.stream(), TICK_MS);
  }

  private list(project: string): DemoRun[] {
    let runs = this.runs.get(project);
    if (!runs) {
      runs = [];
      this.runs.set(project, runs);
    }
    return runs;
  }

  private find(project: string, runId: string): DemoRun | undefined {
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

  private emit(project: string, run: DemoRun, type: string, payload: unknown): void {
    const last = run.events.at(-1);
    const event: RunEvent = {
      sequence: (last?.sequence ?? 0) + 1,
      id: `${run.state.id}-${(last?.sequence ?? 0) + 1}`,
      schemaVersion: 1,
      runId: run.state.id,
      type,
      occurredAt: new Date().toISOString(),
      payload,
      traceId: "a".repeat(32),
      spanId: ((last?.sequence ?? 0) + 1).toString(16).padStart(16, "0"),
    };
    run.events.push(event);
    for (const entry of this.listeners) {
      if (entry.project === project && (entry.runId === undefined || entry.runId === run.state.id)) entry.fn(event);
    }
  }

  private touch(project: string, run: DemoRun, status?: RunStatus, message?: string): void {
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
    const def = demoConfig.strategies.definitions[strategy ?? "balanced"] ?? demoConfig.strategies.definitions.balanced!;
    const now = new Date().toISOString();
    const state: RunState = {
      id,
      goal,
      status: "created",
      strategy: {
        name: strategy ?? "balanced",
        maxParallel: def.maxParallel ?? 3,
        maxReworkAttempts: def.maxReworkAttempts ?? 2,
        executionTimeoutSeconds: 900,
        maxAgentInvocations: 64,
        maxProcessOutputBytes: 4_000_000,
        maxArtifactBytes: 8_000_000,
        roleProfiles: def.roleProfiles,
        approvalGates: def.approvalGates ?? ["final"],
        approvalTimeoutSeconds: 3600,
        topology: def.compiledTopology,
      },
      profileOverrides: {},
      createdAt: now,
      updatedAt: now,
      tasks: [],
      history: [{ at: now, status: "created", message: "运行已创建" }],
    };
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

  private demoAgents(run: DemoRun): LiveAgent[] {
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
    switch (action) {
      case "respond-approval": {
        const approval = run.state.approvals?.find((item) => item.id === body.requestId);
        if (approval) {
          const decision = body.decision === "approved" ? "approved" : "rejected";
          approval.status = decision;
          approval.response = { decision, actor: String(body.actor ?? "demo"), reason: String(body.reason ?? ""), respondedAt: new Date().toISOString() };
          this.emit(project, run, "approval.responded", { gate: approval.gate, decision, reason: body.reason });
        }
        this.touch(project, run, body.decision === "approved" ? "ready-to-merge" : "blocked", body.decision === "approved" ? "审批通过" : "审批驳回");
        return {};
      }
      case "pause":
        this.touch(project, run, "interrupted", "已暂停");
        return {};
      case "cancel":
        this.touch(project, run, "cancelled", "已取消");
        return {};
      case "resume":
        this.touch(project, run, "implementing", "从检查点继续");
        return {};
      case "publish":
        run.state.pullRequestUrl = "https://example.com/storefront/pull/200";
        run.state.pullRequestNumber = 200;
        this.touch(project, run, "completed", "已发布");
        return { runId, status: "completed", pullRequestUrl: run.state.pullRequestUrl };
      case "retry":
        return { runId: this.createRun(project, run.state.goal, run.state.strategy.name) };
      case "delete": {
        const runs = this.list(project);
        runs.splice(runs.indexOf(run), 1);
        return { deletedRunIds: [runId], reclaimedBytes: 0 };
      }
      default:
        return undefined;
    }
  }

  handle(method: string, rawPath: string, body: Record<string, unknown>): { status: number; body: unknown } {
    const scoped = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(rawPath);
    const project = scoped ? decodeURIComponent(scoped[1]!) : "storefront";
    const path = (scoped ? scoped[2] ?? "" : rawPath.replace(/^\/api/, "")).split("?")[0]!;
    const ok = (payload: unknown) => ({ status: 200, body: payload });
    const runs = this.list(project);

    if (path === "/workspace") return ok(demoWorkspace);
    if (path === "/config") return ok(demoConfig);
    if (path === "/desktop/settings") return ok(demoDesktopSettings);
    if (path.startsWith("/desktop/cli-inventory")) return ok({ inventory: demoDesktopSettings.inventory, fromCache: true });
    if (path === "/evolution") return ok(demoEvolution);
    if (path === "/experience") return ok(buildExperience(this.base));
    if (path === "/experience/retrieve") return ok({ note: "演示数据", items: [] });
    if (path === "/usage") return ok(buildUsage(runs));
    if (path === "/jev/probe") return ok({ ok: false, latencyMs: 0, error: "演示模式不连接本地模型" });
    if (path === "/role-settings") {
      return ok({ projectId: project, projectName: project, roles: {}, global: demoDesktopSettings.settings.defaults.roles, effective: demoDesktopSettings.settings.defaults.roles, sources: {} });
    }
    if (path === "/runs" && method === "GET") return ok({ runs: runs.map((entry) => summarize(entry.state)) });
    if (path === "/runs" && method === "POST") {
      return ok({ runId: this.createRun(project, String(body.goal ?? "演示运行"), typeof body.strategy === "string" ? body.strategy : undefined) });
    }
    if (path === "/runs/cleanup/preview") {
      const candidates = runs
        .filter((entry) => ["completed", "cancelled", "blocked", "interrupted"].includes(entry.state.status))
        .map((entry) => ({ id: entry.state.id, goal: entry.state.goal, status: entry.state.status as "completed", updatedAt: entry.state.updatedAt, bytes: 120_000 }));
      return ok({ token: "demo-token", expiresAt: iso(10 * minute, Date.now()), olderThanDays: Number(body.olderThanDays ?? 7), cutoff: new Date().toISOString(), candidates, totalBytes: candidates.length * 120_000 });
    }
    if (path === "/runs/cleanup") return ok({ deletedRunIds: [], reclaimedBytes: 0 });

    const match = /^\/runs\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (match) {
      const runId = decodeURIComponent(match[1]!);
      const rest = match[2];
      const run = this.find(project, runId);
      if (!run) return { status: 404, body: { error: "运行不存在" } };
      if (!rest) return ok({ run: run.state });
      if (rest === "evidence") return ok({ evidence: buildEvidence(run) });
      if (rest === "evidence/file") return ok({ file: { path: "plan/architect-output.md", size: 120, content: "# 演示产物\n\n这是演示数据，不对应真实文件。\n", truncated: false } });
      if (rest === "export") return ok({});
      if (rest === "agents") return ok({ agents: this.demoAgents(run) });
      if (rest === "explain") return ok({ explanation: demoExplanation(run) });
      if (rest === "usage") return ok({ usage: demoUsageBreakdown(run) });
      if (rest === "replay") return ok({ steps: demoReplay(run) });
      if (rest === "transcripts") return ok({ transcripts: demoTranscripts(run) });
      if (rest === "transcript") return ok({ transcript: demoTranscript(new URLSearchParams(rawPath.split("?")[1] ?? "").get("id") ?? "") });
      const taskDiff = /^tasks\/([^/]+)\/diff$/.exec(rest ?? "");
      if (taskDiff) return ok({ diff: demoTaskDiff(run, decodeURIComponent(taskDiff[1]!)) });
      const agentAction = /^agents\/([^/]+)\/(steer|interrupt|answer)$/.exec(rest ?? "");
      if (agentAction && method === "POST") {
        const agentId = decodeURIComponent(agentAction[1]!);
        const actor = String(body.actor ?? "demo");
        if (agentAction[2] === "steer") this.emit(project, run, "agent.steered", { agentId, actor, text: body.text });
        else if (agentAction[2] === "interrupt") this.emit(project, run, "agent.interrupted", { agentId, actor, note: body.note, redirected: body.note !== undefined });
        else this.emit(project, run, "agent.answered", { agentId, actor, questionId: body.questionId, answer: body.answer });
        return ok({ ok: true });
      }
      const action = /^actions\/(.+)$/.exec(rest);
      if (action && method === "POST") {
        const result = this.act(project, runId, action[1]!, body);
        return result === undefined ? { status: 404, body: { error: "演示模式不支持该操作" } } : ok(result);
      }
    }
    return { status: 404, body: { error: "演示模式不支持该操作" } };
  }
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
    const parsed = new URL(url, window.location.origin);
    const scoped = /^\/api\/projects\/([^/]+)/.exec(parsed.pathname);
    const project = scoped ? decodeURIComponent(scoped[1]!) : "storefront";
    const runId = parsed.searchParams.get("runId") ?? undefined;
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
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : input.url;
    const path = url.startsWith("http") ? new URL(url).pathname + new URL(url).search : url;
    if (!path.startsWith("/api")) return await nativeFetch(input, init);
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string" && init.body) {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    await new Promise((resolve) => window.setTimeout(resolve, 60));
    const result = server.handle((init?.method ?? "GET").toUpperCase(), path, body);
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { "Content-Type": "application/json" } });
  };
  class BoundEventSource extends DemoEventSource {
    constructor(url: string) {
      super(url, server);
    }
  }
  (window as unknown as { EventSource: unknown }).EventSource = BoundEventSource;
}
