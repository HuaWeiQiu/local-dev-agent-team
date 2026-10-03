import type {
  ApprovalRequest,
  CompiledStrategyTopology,
  DesktopSettingsResponse,
  EvolutionSnapshot,
  ExperienceSnapshot,
  PublicConfig,
  RunEvent,
  RunEvidence,
  RunState,
  RunStatus,
  StrategyDefinition,
  Task,
  TaskRunState,
  TaskStatus,
  UsageReport,
  WorkspaceInfo,
} from "../types";

/** Seeded, offline sample data for `?demo=1`. Nothing here talks to a server or an agent CLI. */

export const DEMO_PROJECTS = [
  { id: "storefront", name: "storefront", defaultBranch: "main" },
  { id: "docs-site", name: "docs-site", defaultBranch: "main" },
] as const;

export const demoWorkspace: WorkspaceInfo = {
  mode: "workspace",
  defaultProjectId: "storefront",
  projects: DEMO_PROJECTS.map((project) => ({ ...project })),
  connectedCount: 2,
  registeredCount: 2,
};

const topology = (mode: "parallel-dag" | "sequential"): CompiledStrategyTopology => ({
  version: 1,
  mode,
  stages: [
    { id: "plan", kind: "agent", label: "规划", roles: ["architect"] },
    { id: "implement", kind: "worker-pool", label: "实现", roles: ["worker"] },
    { id: "review", kind: "agent", label: "评审与测试", roles: ["reviewer", "tester"] },
    { id: "gate", kind: "quality-gate", label: "质量门", roles: [] },
    { id: "approve", kind: "human-approval", label: "人工审批", roles: [] },
    { id: "publish", kind: "publication", label: "发布", roles: [] },
  ],
  edges: [
    { source: "plan", target: "implement" },
    { source: "implement", target: "review" },
    { source: "review", target: "gate" },
    { source: "gate", target: "approve" },
    { source: "approve", target: "publish" },
  ],
});

function strategy(maxParallel: number, rework: number, gates: Array<"plan" | "final">, mode: "parallel-dag" | "sequential" = "parallel-dag"): StrategyDefinition {
  return {
    topology: { mode },
    compiledTopology: topology(mode),
    source: "config",
    maxParallel,
    maxReworkAttempts: rework,
    executionTimeoutSeconds: 900,
    maxAgentInvocations: 64,
    maxProcessOutputBytes: 4_000_000,
    maxArtifactBytes: 8_000_000,
    roleProfiles: { architect: "claude-opus", worker: "codex-gpt", reviewer: "claude-opus", tester: "codex-gpt" },
    approvalGates: gates,
    approvalTimeoutSeconds: 3600,
    taskMorphology: { advisor: { enabled: true, triggers: ["repeated-failure", "pre-final"], maxConsultationsPerRun: 2 } },
  };
}

export const demoConfig: PublicConfig = {
  project: { name: "storefront", defaultBranch: "main", stateDirectory: ".agent-team", maxParallel: 3 },
  profiles: {
    "claude-opus": { adapter: "claude", model: "claude-opus", reasoning: "high", permission: "read-only", externalTools: "deny" },
    "codex-gpt": { adapter: "codex", model: "gpt-5", reasoning: "medium", permission: "workspace-write", externalTools: "deny" },
  },
  roles: {
    architect: { defaultProfile: "claude-opus", allowedProfiles: ["claude-opus"], fallbackProfiles: [] },
    worker: { defaultProfile: "codex-gpt", allowedProfiles: ["codex-gpt"], fallbackProfiles: [] },
    reviewer: { defaultProfile: "claude-opus", allowedProfiles: ["claude-opus"], fallbackProfiles: [] },
    tester: { defaultProfile: "codex-gpt", allowedProfiles: ["codex-gpt"], fallbackProfiles: [] },
  },
  strategies: {
    default: "balanced",
    definitions: {
      balanced: strategy(3, 2, ["final"]),
      strict: strategy(2, 3, ["plan", "final"]),
      sequential: strategy(1, 2, ["final"], "sequential"),
    },
  },
  observability: { maxEventsPerRun: 20_000 },
  interop: {
    schemaVersion: 1,
    adapters: [],
    protocols: {
      mcp: { specification: "2025-06-18", mode: "agent-cli", defaultPolicy: "deny", executionOwner: "agent-cli" },
      a2a: { specification: "draft", mode: "disabled", requires: [] },
    },
    configuredProfiles: [],
  },
};

const minute = 60_000;

export function iso(offsetMs: number, base: number): string {
  return new Date(base + offsetMs).toISOString();
}

function task(id: string, title: string, dependsOn: string[], paths: string[], description = title): Task {
  return {
    id,
    title,
    description,
    dependsOn,
    ownedPaths: paths,
    acceptanceCommands: [{ command: "pnpm", args: ["test", "--run"] }],
    profile: null,
  };
}

function taskState(source: Task, status: TaskStatus, extra: Partial<TaskRunState> = {}): TaskRunState {
  const done = status === "merged" || status === "passed";
  return {
    task: source,
    status,
    attempts: status === "pending" ? 0 : 1,
    ...(status !== "pending" ? { branch: `agent/${source.id}`, worktree: `.agent-team/worktrees/${source.id}` } : {}),
    ...(done ? { commit: `${source.id.replace(/\D/g, "").padEnd(3, "a")}c0de1f`.slice(0, 7) } : {}),
    ...(done
      ? {
          quality: {
            passed: true,
            commands: [{ spec: { command: "pnpm", args: ["test", "--run"] }, exitCode: 0, durationMs: 18_400, timedOut: false }],
          },
          review: { verdict: "approve" as const, summary: "改动聚焦、命名清晰，没有越权修改。", findings: [] },
          test: { verdict: "approve" as const, summary: "新增用例覆盖了主路径与失败路径。", missingTests: [] },
        }
      : {}),
    ...extra,
  };
}

function baseState(id: string, goal: string, status: RunStatus, createdAgo: number, base: number, overrides: Partial<RunState>): RunState {
  const def = demoConfig.strategies.definitions.balanced!;
  return {
    id,
    goal,
    status,
    strategy: {
      name: "balanced",
      maxParallel: def.maxParallel ?? 3,
      maxReworkAttempts: def.maxReworkAttempts ?? 2,
      executionTimeoutSeconds: 900,
      maxAgentInvocations: 64,
      maxProcessOutputBytes: 4_000_000,
      maxArtifactBytes: 8_000_000,
      roleProfiles: def.roleProfiles,
      approvalGates: ["final"],
      approvalTimeoutSeconds: 3600,
      topology: def.compiledTopology,
      advisor: { enabled: true, triggers: ["repeated-failure", "pre-final"], maxConsultationsPerRun: 2 },
    },
    profileOverrides: {},
    createdAt: iso(-createdAgo, base),
    updatedAt: iso(-Math.max(0, createdAgo - 20 * minute), base),
    tasks: [],
    history: [],
    ...overrides,
  };
}

export interface DemoRun {
  state: RunState;
  events: RunEvent[];
  diff: string;
  changedFiles: string[];
}

function history(base: number, start: number, steps: Array<[RunStatus, string, number]>): RunState["history"] {
  return steps.map(([status, message, offset]) => ({ at: iso(start + offset * minute, base), status, message }));
}

const finalDiff = `diff --git a/src/cart/CartSummary.tsx b/src/cart/CartSummary.tsx
index 3f1a2b4..9c7d0e1 100644
--- a/src/cart/CartSummary.tsx
+++ b/src/cart/CartSummary.tsx
@@ -12,9 +12,22 @@ export function CartSummary({ items }: Props) {
-  const total = items.reduce((sum, item) => sum + item.price, 0);
+  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
+  const discount = applyCoupon(total, coupon);
   return (
     <section aria-label="购物车汇总">
-      <p>合计：{formatPrice(total)}</p>
+      <p>合计：{formatPrice(total)}</p>
+      {discount > 0 ? <p className="discount">优惠：-{formatPrice(discount)}</p> : null}
+      <p className="payable">应付：{formatPrice(total - discount)}</p>
     </section>
   );
 }
diff --git a/src/cart/coupon.ts b/src/cart/coupon.ts
new file mode 100644
--- /dev/null
+++ b/src/cart/coupon.ts
@@ -0,0 +1,18 @@
+export interface Coupon {
+  code: string;
+  percentOff: number;
+  maxDiscountCents: number;
+}
+
+export function applyCoupon(totalCents: number, coupon: Coupon | undefined): number {
+  if (!coupon || totalCents <= 0) return 0;
+  const raw = Math.floor((totalCents * coupon.percentOff) / 100);
+  return Math.min(raw, coupon.maxDiscountCents);
+}
`;

export function buildDemoRuns(base: number): DemoRun[] {
  // 1) 等待最终审批：已规划、实现并通过评审，卡在人工门
  const t1 = [
    task("task-coupon", "实现优惠券计算", [], ["src/cart/coupon.ts"]),
    task("task-summary", "购物车汇总展示优惠与应付", ["task-coupon"], ["src/cart/CartSummary.tsx"]),
    task("task-tests", "补充优惠券与汇总的单元测试", ["task-coupon"], ["test/cart/*.test.ts"]),
    task("task-docs", "更新结算流程文档", ["task-summary"], ["docs/checkout.md"]),
  ];
  const approval: ApprovalRequest = {
    id: "approval-demo-1",
    gate: "final",
    status: "pending",
    summary: "4 个任务已合并到集成分支，测试与类型检查通过。请确认是否发布 PR。",
    checkpointId: "checkpoint-3",
    requestedAt: iso(-6 * minute, base),
    expiresAt: iso(54 * minute, base),
  };
  const awaiting = baseState("demo-awaiting-approval", "给购物车增加优惠券，并在汇总里展示优惠与应付金额", "awaiting-human", 52 * minute, base, {
    plan: { summary: "先实现纯函数优惠券计算，再接入汇总组件，最后补测试与文档。", tasks: t1 },
    tasks: t1.map((item) => taskState(item, "merged")),
    approvals: [approval],
    finalQuality: {
      passed: true,
      commands: [
        { spec: { command: "pnpm", args: ["check"] }, exitCode: 0, durationMs: 9_800 },
        { spec: { command: "pnpm", args: ["test"] }, exitCode: 0, durationMs: 21_300 },
        { spec: { command: "pnpm", args: ["lint"] }, exitCode: 0, durationMs: 6_100 },
      ],
    },
    finalDecision: { decision: "ready", reason: "确定性检查全部通过，评审与测试均已批准。" },
    advisorConsultations: 1,
    history: history(base, -52 * minute, [
      ["created", "运行已创建", 0], ["orchestrating", "总控分析目标", 1], ["architecting", "架构拆分任务", 3],
      ["implementing", "开始实现", 7], ["reviewing-testing", "评审与测试", 25], ["integrating", "集成分支", 36],
      ["final-checks", "运行质量门", 40], ["awaiting-human", "等待最终审批", 46],
    ]),
    usage: { agentInvocations: 14, agentDurationMs: 1_240_000, processOutputBytes: 420_000, truncatedStreams: 0, artifactBytes: 88_000, inputTokens: 412_000, cachedInputTokens: 260_000, outputTokens: 38_500, reportedCostUsd: 3.84 },
  });

  // 2) 执行中：5 个任务，2 已合并、2 进行中、1 待开始
  const t2 = [
    task("task-schema", "设计订单导出的数据结构", [], ["src/export/schema.ts"]),
    task("task-csv", "实现 CSV 导出器", ["task-schema"], ["src/export/csv.ts"]),
    task("task-api", "新增 /api/orders/export 接口", ["task-schema"], ["src/api/export.ts"]),
    task("task-ui", "订单页增加导出按钮与进度提示", ["task-api"], ["src/orders/ExportButton.tsx"]),
    task("task-e2e", "补充导出流程的端到端测试", ["task-ui", "task-csv"], ["e2e/export.spec.ts"]),
  ];
  const running = baseState("demo-running", "为订单列表增加 CSV 导出，支持按时间范围筛选", "implementing", 18 * minute, base, {
    plan: { summary: "先定数据结构，CSV 与接口并行，随后接 UI，最后补端到端测试。", tasks: t2 },
    tasks: [
      taskState(t2[0]!, "merged"),
      taskState(t2[1]!, "working"),
      taskState(t2[2]!, "working"),
      taskState(t2[3]!, "pending"),
      taskState(t2[4]!, "pending"),
    ],
    history: history(base, -18 * minute, [
      ["created", "运行已创建", 0], ["orchestrating", "总控分析目标", 1], ["architecting", "架构拆分任务", 3], ["implementing", "开始实现", 7],
    ]),
    usage: { agentInvocations: 6, agentDurationMs: 410_000, processOutputBytes: 180_000, truncatedStreams: 0, artifactBytes: 24_000, inputTokens: 188_000, cachedInputTokens: 96_000, outputTokens: 14_200, reportedCostUsd: 1.42 },
  });

  // 3) 被阻塞：评审连续要求修改，超过返工上限
  const t3 = [
    task("task-token", "把访问令牌改为短期令牌并支持刷新", [], ["src/auth/token.ts"]),
    task("task-guard", "为受保护路由接入令牌校验", ["task-token"], ["src/auth/guard.ts"]),
  ];
  const blocked = baseState("demo-blocked", "把登录改成短期令牌 + 刷新令牌，旧会话平滑迁移", "blocked", 3 * 60 * minute, base, {
    plan: { summary: "先改令牌模块，再接入路由守卫。", tasks: t3 },
    tasks: [
      taskState(t3[0]!, "blocked", {
        attempts: 3,
        review: {
          verdict: "request_changes",
          summary: "刷新逻辑存在竞态：并发请求会重复刷新并使旧令牌失效。",
          findings: [
            { severity: "high", path: "src/auth/token.ts", line: 48, message: "refresh() 没有单飞保护，两个并发 401 会各自刷新一次。", required: true },
            { severity: "medium", path: "src/auth/token.ts", line: 71, message: "过期时间使用本地时钟，应改用服务端返回的 expiresIn。", required: true },
          ],
        },
        test: { verdict: "request_changes", summary: "缺少并发刷新与过期边界的测试。", missingTests: ["并发 401 只触发一次刷新", "令牌恰好过期的边界"] },
        error: "评审连续 3 次要求修改，已超过返工上限",
      }),
      taskState(t3[1]!, "pending"),
    ],
    error: "任务 task-token 在 3 次尝试后仍未通过评审",
    advisorConsultations: 2,
    history: history(base, -180 * minute, [
      ["created", "运行已创建", 0], ["orchestrating", "总控分析目标", 1], ["architecting", "架构拆分任务", 4], ["implementing", "开始实现", 9],
      ["reviewing-testing", "评审与测试", 40], ["reworking", "返工", 55], ["blocked", "返工次数用尽", 120],
    ]),
    usage: { agentInvocations: 19, agentDurationMs: 2_140_000, processOutputBytes: 760_000, truncatedStreams: 1, artifactBytes: 120_000, inputTokens: 690_000, cachedInputTokens: 410_000, outputTokens: 61_000, reportedCostUsd: 6.1 },
  });

  // 4) 已完成并发布 PR
  const t4 = [
    task("task-i18n", "提取结算页文案到 i18n 资源", [], ["src/i18n/checkout.ts"]),
    task("task-toggle", "语言切换器写入 localStorage", ["task-i18n"], ["src/i18n/toggle.tsx"]),
  ];
  const done = baseState("demo-completed", "结算页支持中英文切换，并记住用户选择", "completed", 26 * 60 * minute, base, {
    plan: { summary: "文案提取后接入切换器。", tasks: t4 },
    tasks: t4.map((item) => taskState(item, "merged")),
    finalQuality: { passed: true },
    finalDecision: { decision: "ready", reason: "全部检查通过。" },
    pullRequestUrl: "https://example.com/storefront/pull/128",
    pullRequestNumber: 128,
    history: history(base, -26 * 60 * minute, [
      ["created", "运行已创建", 0], ["architecting", "架构拆分任务", 3], ["implementing", "开始实现", 6], ["reviewing-testing", "评审与测试", 22],
      ["integrating", "集成分支", 31], ["final-checks", "运行质量门", 34], ["awaiting-human", "等待最终审批", 38], ["publishing", "发布 PR", 44], ["completed", "已完成", 52],
    ]),
    usage: { agentInvocations: 9, agentDurationMs: 860_000, processOutputBytes: 260_000, truncatedStreams: 0, artifactBytes: 52_000, inputTokens: 240_000, cachedInputTokens: 150_000, outputTokens: 21_000, reportedCostUsd: 2.05 },
  });

  // 5) CI 失败
  const t5 = [task("task-cache", "给商品列表接口加 60s 缓存", [], ["src/api/products.ts"])];
  const ciFailed = baseState("demo-ci-failed", "商品列表接口加缓存并在库存变化时失效", "ci-failed", 7 * 60 * minute, base, {
    plan: { summary: "单任务：缓存加失效。", tasks: t5 },
    tasks: t5.map((item) => taskState(item, "merged")),
    finalQuality: { passed: true },
    finalDecision: { decision: "ready", reason: "本地检查通过。" },
    pullRequestUrl: "https://example.com/storefront/pull/131",
    pullRequestNumber: 131,
    error: "CI 的 e2e 作业失败：products.spec.ts 超时",
    history: history(base, -7 * 60 * minute, [
      ["created", "运行已创建", 0], ["architecting", "架构拆分任务", 3], ["implementing", "开始实现", 6], ["final-checks", "运行质量门", 28],
      ["publishing", "发布 PR", 34], ["waiting-ci", "等待 CI", 36], ["ci-failed", "CI 失败", 51],
    ]),
    usage: { agentInvocations: 7, agentDurationMs: 600_000, processOutputBytes: 140_000, truncatedStreams: 0, artifactBytes: 31_000, inputTokens: 150_000, cachedInputTokens: 80_000, outputTokens: 12_400, reportedCostUsd: 1.18 },
  });

  const runs = [awaiting, running, blocked, done, ciFailed];
  return runs.map((state) => ({
    state,
    events: buildEvents(state, base),
    diff: state.id === "demo-awaiting-approval" || state.id === "demo-completed" ? finalDiff : "",
    changedFiles: state.id === "demo-awaiting-approval" || state.id === "demo-completed" ? ["src/cart/CartSummary.tsx", "src/cart/coupon.ts"] : [],
  }));
}

function buildEvents(state: RunState, base: number): RunEvent[] {
  const events: RunEvent[] = [];
  let sequence = 0;
  const push = (offsetMs: number, type: string, payload: unknown) => {
    sequence += 1;
    events.push({
      sequence,
      id: `${state.id}-${sequence}`,
      schemaVersion: 1,
      runId: state.id,
      type,
      occurredAt: new Date(offsetMs).toISOString(),
      payload,
      traceId: "a".repeat(32),
      spanId: sequence.toString(16).padStart(16, "0"),
    });
  };
  const start = Date.parse(state.createdAt);
  const profileFor = (role: string) => state.strategy.roleProfiles[role] ?? "default";
  const invoke = (offset: number, role: string, id: string, success: boolean | undefined, note?: string) => {
    const profile = profileFor(role);
    const adapter = profile.startsWith("claude") ? "claude" : "codex";
    push(start + offset, "agent.invocation.started", { role, profile, adapter, invocationId: id, model: profile });
    if (note) push(start + offset + 4_000, "agent.stdout", { invocationId: id, text: `${note}\n` });
    if (success !== undefined) {
      push(start + offset + 40_000, "agent.invocation.completed", { role, profile, adapter, invocationId: id, success, model: profile });
    }
  };
  invoke(5_000, "architect", `${state.id}-arch`, true, "读取仓库结构，拆分为可并行的任务图…");
  for (const [index, item] of state.tasks.entries()) {
    const offset = 6 * minute + index * 90_000;
    push(start + offset - 5_000, "run.wave.started", { taskIds: [item.task.id] });
    const finished = item.status === "merged" || item.status === "passed";
    const stuck = item.status === "blocked";
    if (item.status === "pending") continue;
    invoke(offset, "worker", `${state.id}-w${index}`, finished || stuck ? true : undefined, `实现 ${item.task.title}\n$ pnpm test --run\n${finished ? "✓ 全部通过" : "运行中…"}`);
    if (finished) {
      invoke(offset + 50_000, "reviewer", `${state.id}-r${index}`, true, "审查改动：边界清晰，无越权修改。");
      push(start + offset + 95_000, "run.wave.completed", { taskIds: [item.task.id], status: "passed" });
    } else if (stuck) {
      invoke(offset + 50_000, "reviewer", `${state.id}-r${index}`, true, "request_changes：refresh() 存在并发竞态。");
      push(start + offset + 95_000, "run.wave.completed", { taskIds: [item.task.id], status: "blocked" });
      push(start + offset + 100_000, "run.advisor.consulted", { trigger: "repeated-failure", recommendation: "stop", summary: "竞态需要重新设计刷新协议，继续重试收益低。" });
    }
  }
  for (const approval of state.approvals ?? []) {
    push(Date.parse(approval.requestedAt), "approval.requested", { gate: approval.gate, requestId: approval.id });
  }
  if (state.status === "blocked" || state.status === "ci-failed") {
    push(Date.parse(state.updatedAt), "run.updated", { status: state.status });
  }
  void base;
  return events;
}

export function buildEvidence(run: DemoRun): RunEvidence {
  const { state } = run;
  const finished = state.tasks.filter((item) => item.status === "merged" || item.status === "passed").length;
  const total = state.tasks.length;
  const approvalPending = (state.approvals ?? []).some((approval) => approval.status === "pending");
  const failed = state.status === "blocked" || state.status === "ci-failed";
  return {
    runId: state.id,
    status: state.status,
    readiness: failed ? "attention" : state.status === "completed" || approvalPending ? "ready" : "in-progress",
    checks: [
      { id: "tasks", label: "任务", status: finished === total && total > 0 ? "pass" : failed ? "fail" : "pending", detail: `${finished}/${total} 个任务已通过` },
      { id: "quality", label: "确定性检查", status: state.finalQuality ? (state.finalQuality.passed ? "pass" : "fail") : "pending", detail: state.finalQuality ? "check / test / lint" : "尚未运行" },
      { id: "decision", label: "总控裁决", status: state.finalDecision ? "pass" : "pending", detail: state.finalDecision?.reason ?? "等待裁决" },
      { id: "approval", label: "人工审批", status: approvalPending ? "pending" : state.status === "completed" ? "pass" : "pending", detail: approvalPending ? "等待你确认" : "无需审批" },
    ],
    tasks: state.tasks.map((item) => ({
      id: item.task.id,
      title: item.task.title,
      status: item.status,
      attempts: item.attempts,
      ...(item.commit ? { commit: item.commit } : {}),
      ...(item.quality ? { qualityPassed: item.quality.passed } : {}),
      ...(item.review ? { reviewVerdict: item.review.verdict } : {}),
      ...(item.test ? { testVerdict: item.test.verdict } : {}),
      findingCount: item.review?.findings.length ?? 0,
    })),
    artifacts: [
      { path: "plan/architect-output.md", size: 3_200, kind: "agent-output", previewable: true },
      { path: "quality/final.json", size: 1_900, kind: "quality", previewable: true },
    ],
    artifactBytes: state.usage?.artifactBytes ?? 0,
    diff: {
      available: run.diff.length > 0,
      baseCommit: "9a1b2c3",
      ...(run.diff ? { targetCommit: "e4f5a6b", content: run.diff } : {}),
      changedFiles: run.changedFiles,
      truncated: false,
      ...(run.diff ? {} : { detail: "该运行尚未产生可对比的集成提交" }),
    },
  };
}

export function buildUsage(runs: DemoRun[]): UsageReport {
  const totals = {
    agentInvocations: 0, agentDurationMs: 0, processOutputBytes: 0, truncatedStreams: 0, artifactBytes: 0,
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reportedCostUsd: 0, costReported: true,
  };
  const entries = runs.map(({ state }) => {
    const usage = state.usage;
    const detail = {
      agentInvocations: usage?.agentInvocations ?? 0,
      agentDurationMs: usage?.agentDurationMs ?? 0,
      processOutputBytes: usage?.processOutputBytes ?? 0,
      truncatedStreams: usage?.truncatedStreams ?? 0,
      artifactBytes: usage?.artifactBytes ?? 0,
      inputTokens: usage?.inputTokens ?? 0,
      cachedInputTokens: usage?.cachedInputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      reportedCostUsd: usage?.reportedCostUsd ?? 0,
      costReported: true,
    };
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
      if (key === "costReported") continue;
      totals[key] += detail[key];
    }
    return { runId: state.id, goal: state.goal, status: state.status, strategy: state.strategy.name, createdAt: state.createdAt, updatedAt: state.updatedAt, usage: detail };
  });
  return { generatedAt: new Date().toISOString(), runCount: runs.length, totals, runs: entries };
}

export const demoDesktopSettings: DesktopSettingsResponse = {
  settings: {
    version: 1,
    defaults: {
      roles: {
        architect: { cli: "claude", model: "claude-opus", reasoning: "high" },
        worker: { cli: "codex", model: "gpt-5", reasoning: "medium" },
        reviewer: { cli: "claude", model: "claude-opus", reasoning: "high" },
        tester: { cli: "codex", model: "gpt-5", reasoning: "medium" },
      },
    },
    ui: { showCliPickerInRunLauncher: true, autoDetectCliConfig: true, autoDetectOnFocus: true },
    inventoryCachedAt: new Date().toISOString(),
  },
  inventory: {
    scannedAt: new Date().toISOString(),
    home: "~",
    clis: (["claude", "codex", "kimi", "grok"] as const).map((id) => ({
      id,
      installed: id === "claude" || id === "codex",
      ...(id === "claude" || id === "codex" ? { version: "demo", binary: `/usr/local/bin/${id}` } : {}),
      auth: { status: id === "claude" || id === "codex" ? ("present" as const) : ("missing" as const) },
      configPaths: [],
      models: id === "claude"
        ? [{ id: "claude-opus", label: "Claude Opus", reasoningOptions: ["low", "medium", "high"] }]
        : id === "codex"
          ? [{ id: "gpt-5", label: "GPT-5", reasoningOptions: ["low", "medium", "high"] }]
          : [],
      runtimeSupported: true,
    })),
  },
  fromCache: true,
  suggestedDefaults: {},
};

export const demoEvolution: EvolutionSnapshot = {
  catalogRevision: 1,
  applicationRevision: 1,
  recoveryRequired: false,
  promptRoles: [],
  proposals: [],
  activeProposals: [],
  auditRecords: [],
  completedApplications: [],
  pendingOperation: null,
  automation: {
    enabled: false, autoStart: false, status: "idle", phase: "idle", configuredMaxCycles: 3, requestedMaxCycles: null,
    completedCycles: 0, maxConsecutiveNoImprovement: 2, consecutiveNoImprovement: 0, evaluationRepeats: 1, minimumScoreDelta: 0.05,
    baselineStrategy: null, targetStrategy: "balanced", sessionId: null, activeRunId: null, incumbentScore: null, incumbentStrategy: null,
    stopReason: null, error: null, failureCode: null, roleBindingSource: null, startedAt: null, updatedAt: new Date().toISOString(),
    lastEvaluation: null, cycles: [],
  },
  evidenceScope: "server-structural-preflight-not-candidate-execution",
};

export function buildExperience(base: number): ExperienceSnapshot {
  const entry = (id: string, status: "candidate" | "verified", summary: string, tags: string[]) => ({
    id, project: "storefront", status, summary, conditions: ["修改购物车或结算相关代码时"], sourceRunId: "demo-completed",
    sensitivity: "low" as const, scope: "project" as const, portability: "project-bound" as const, tags,
    hitCount: status === "verified" ? 4 : 0, successCount: status === "verified" ? 3 : 0,
    createdAt: iso(-2 * 24 * 60 * minute, base), updatedAt: iso(-60 * minute, base),
  });
  return {
    project: "storefront", projectPath: ".agent-team/experience", sharedPath: "~/.agent-team/shared", enabled: true,
    injectIntoPlanning: true, extractOnTerminal: true,
    counts: { project: 2, shared: 0, verified: 1, candidate: 1 },
    entries: [
      entry("exp-1", "verified", "金额一律用整数分计算，展示层再格式化，避免浮点误差。", ["money", "cart"]),
      entry("exp-2", "candidate", "新增接口必须同时补充 e2e 用例，否则 CI 里会因超时被拦住。", ["ci", "e2e"]),
    ],
  };
}
