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

function task(id: string, title: string, dependsOn: string[], paths: string[], description = title, elementId?: string): Task {
  return {
    id,
    title,
    description,
    dependsOn,
    ownedPaths: paths,
    acceptanceCommands: [{ command: "pnpm", args: ["test", "--run"] }],
    profile: null,
    ...(elementId ? { elementId } : {}),
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
    task("task-coupon", "实现优惠券计算", [], ["src/cart/coupon.ts"], "实现优惠券计算", "cart"),
    task("task-summary", "购物车汇总展示优惠与应付", ["task-coupon"], ["src/cart/CartSummary.tsx"], "购物车汇总展示优惠与应付", "cart"),
    task("task-tests", "补充优惠券与汇总的单元测试", ["task-coupon"], ["test/cart/*.test.ts"], "补充优惠券与汇总的单元测试", "tests"),
    task("task-docs", "更新结算流程文档", ["task-summary"], ["docs/checkout.md"], "更新结算流程文档", "docs"),
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
    plan: {
      summary: "先实现纯函数优惠券计算，再接入汇总组件，最后补测试与文档。",
      tasks: t1,
      design: {
        summary: "优惠计算留在购物车模块，测试和结算文档分别消费它。",
        source: "architect",
        elements: [
          { id: "cart", name: "购物车", kind: "module", responsibility: "计算优惠并在汇总里展示应付金额。", paths: ["src/cart"] },
          { id: "tests", name: "购物车测试", kind: "module", responsibility: "锁住优惠和汇总的主路径。", paths: ["test/cart"] },
          { id: "docs", name: "结算文档", kind: "data", responsibility: "记录顾客能看到的结算步骤。", paths: ["docs"] },
        ],
        relations: [
          { from: "cart", to: "tests", kind: "depends", label: "测试依赖优惠结果" },
          { from: "cart", to: "docs", kind: "depends", label: "文档跟着汇总改" },
        ],
        sequence: [
          { order: 1, from: "cart", to: "tests", action: "把优惠和应付金额交给测试断言" },
          { order: 2, from: "cart", to: "docs", action: "按汇总结果更新结算说明" },
        ],
      },
    },
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
    repoTrace: {
      matched: true,
      nodes: [
        { id: "root", parentId: null, path: "", name: "root", kind: "directory" },
        { id: "src", parentId: "root", path: "src", name: "src", kind: "directory" },
        { id: "src-cart", parentId: "src", path: "src/cart", name: "cart", kind: "directory" },
        { id: "test", parentId: "root", path: "test", name: "test", kind: "directory" },
        { id: "test-cart", parentId: "test", path: "test/cart", name: "cart", kind: "directory" },
        { id: "docs", parentId: "root", path: "docs", name: "docs", kind: "directory" },
      ],
    },
    history: history(base, -52 * minute, [
      ["created", "运行已创建", 0], ["orchestrating", "总控分析目标", 1], ["architecting", "架构拆分任务", 3],
      ["implementing", "开始实现", 7], ["reviewing-testing", "评审与测试", 25], ["integrating", "集成分支", 36],
      ["final-checks", "运行质量门", 40], ["awaiting-human", "等待最终审批", 46],
    ]),
    usage: { agentInvocations: 14, agentDurationMs: 1_240_000, processOutputBytes: 420_000, truncatedStreams: 0, artifactBytes: 88_000, inputTokens: 412_000, cachedInputTokens: 260_000, outputTokens: 38_500, reportedCostUsd: 3.84 },
  });

  // 2) 执行中：5 个任务，2 已合并、2 进行中、1 待开始
  const t2 = [
    task("task-schema", "设计订单导出的数据结构", [], ["src/export/schema.ts"], "设计订单导出的数据结构", "export"),
    task("task-csv", "实现 CSV 导出器", ["task-schema"], ["src/export/csv.ts"], "实现 CSV 导出器", "export"),
    task("task-api", "新增 /api/orders/export 接口", ["task-schema"], ["src/api/export.ts"], "新增 /api/orders/export 接口", "api"),
    task("task-ui", "订单页增加导出按钮与进度提示", ["task-api"], ["src/orders/ExportButton.tsx"], "订单页增加导出按钮与进度提示", "orders-ui"),
    task("task-e2e", "补充导出流程的端到端测试", ["task-ui", "task-csv"], ["e2e/export.spec.ts"], "补充导出流程的端到端测试", "e2e"),
  ];
  const running = baseState("demo-running", "为订单列表增加 CSV 导出，支持按时间范围筛选", "implementing", 18 * minute, base, {
    plan: {
      summary: "先定数据结构，CSV 与接口并行，随后接 UI，最后补端到端测试。",
      tasks: t2,
      design: {
        summary: "导出核心产出 CSV，接口把它交给订单页，端到端测试走完整条链路。",
        source: "architect",
        elements: [
          { id: "export", name: "导出核心", kind: "module", responsibility: "定义订单导出结构并生成 CSV。", paths: ["src/export"], nodeId: "src-export" },
          { id: "api", name: "导出接口", kind: "interface", responsibility: "按时间范围提供 /api/orders/export。", paths: ["src/api/export.ts"], nodeId: "src-api" },
          { id: "orders-ui", name: "订单页", kind: "module", responsibility: "提供导出按钮和进度提示。", paths: ["src/orders"], nodeId: "src-orders" },
          { id: "e2e", name: "导出测试", kind: "module", responsibility: "从按钮走到下载文件。", paths: ["e2e"], nodeId: "e2e" },
        ],
        relations: [
          { from: "export", to: "api", kind: "calls", label: "接口取 CSV" },
          { from: "api", to: "orders-ui", kind: "calls", label: "按钮请求导出" },
          { from: "orders-ui", to: "e2e", kind: "depends", label: "测试点击按钮" },
          { from: "export", to: "e2e", kind: "depends", label: "测试核对文件" },
        ],
        sequence: [
          { order: 1, from: "orders-ui", to: "api", action: "按时间范围请求导出" },
          { order: 2, from: "api", to: "export", action: "生成 CSV" },
          { order: 3, from: "e2e", to: "orders-ui", action: "点按钮并核对下载" },
        ],
      },
    },
    tasks: [
      taskState(t2[0]!, "merged"),
      taskState(t2[1]!, "working"),
      taskState(t2[2]!, "working"),
      taskState(t2[3]!, "pending"),
      taskState(t2[4]!, "pending"),
    ],
    explore: {
      summary: "订单导出集中在 src/export，接口和页面只消费它。",
      modules: ["src/export", "src/api", "src/orders"],
      riskPaths: ["src/orders/ExportButton.tsx"],
      suggestedAcceptanceCommands: ["pnpm test --run"],
      forbiddenPaths: [],
      notes: ["时间范围筛选跟导出请求一起传，不另开模块。"],
    },
    repoTrace: {
      matched: true,
      nodes: [
        { id: "root", parentId: null, path: "", name: "root", kind: "directory" },
        { id: "src", parentId: "root", path: "src", name: "src", kind: "directory" },
        { id: "src-export", parentId: "src", path: "src/export", name: "export", kind: "directory" },
        { id: "src-api", parentId: "src", path: "src/api", name: "api", kind: "directory" },
        { id: "src-orders", parentId: "src", path: "src/orders", name: "orders", kind: "directory" },
        { id: "e2e", parentId: "root", path: "e2e", name: "e2e", kind: "directory" },
      ],
    },
    history: history(base, -18 * minute, [
      ["created", "运行已创建", 0], ["orchestrating", "总控分析目标", 1], ["exploring", "只读看过导出相关模块", 2],
      ["architecting", "架构拆分任务", 3], ["implementing", "开始实现", 7],
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

type EventPusher = (offsetMs: number, type: string, payload: unknown) => void;

function buildEvents(state: RunState, base: number): RunEvent[] {
  const events: RunEvent[] = [];
  const push = makePusher(state, events);
  const start = Date.parse(state.createdAt);
  emitArchitect(push, state, start);
  state.tasks.forEach((item, index) => emitTaskEvents(push, state, start, item, index));
  emitApprovals(push, state);
  emitTerminalStatus(push, state);
  void base;
  return events;
}

function makePusher(state: RunState, events: RunEvent[]): EventPusher {
  let sequence = 0;
  return (offsetMs, type, payload) => {
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
}

function emitArchitect(push: EventPusher, state: RunState, start: number): void {
  emitInvocation(push, state, start + 5_000, "architect", `${state.id}-arch`, true, {
    note: "读取仓库结构，拆分为可并行的任务图…",
  });
}

function emitTaskEvents(
  push: EventPusher,
  state: RunState,
  start: number,
  item: RunState["tasks"][number],
  index: number,
): void {
  const offset = 6 * minute + index * 90_000;
  push(start + offset - 5_000, "run.wave.started", { taskIds: [item.task.id] });
  if (item.status === "pending") return;
  const finished = item.status === "merged" || item.status === "passed";
  const stuck = item.status === "blocked";
  emitWorker(push, state, start + offset, item, index, { finished, stuck });
  emitTaskOutcome(push, state, start + offset, item, index, { finished, stuck });
}

function emitWorker(
  push: EventPusher,
  state: RunState,
  at: number,
  item: RunState["tasks"][number],
  index: number,
  outcome: { finished: boolean; stuck: boolean },
): void {
  const settled = outcome.finished || outcome.stuck;
  emitInvocation(push, state, at, "worker", `${state.id}-w${index}`, settled ? true : undefined, {
    note: [
      `实现 ${item.task.title}`,
      "$ pnpm test --run",
      outcome.finished ? "✓ 全部通过" : "运行中…",
    ].join("\n"),
  });
}

function emitTaskOutcome(
  push: EventPusher,
  state: RunState,
  at: number,
  item: RunState["tasks"][number],
  index: number,
  outcome: { finished: boolean; stuck: boolean },
): void {
  if (outcome.finished) {
    emitInvocation(push, state, at + 50_000, "reviewer", `${state.id}-r${index}`, true, {
      note: "审查改动：边界清晰，无越权修改。",
    });
    push(at + 95_000, "run.wave.completed", { taskIds: [item.task.id], status: "passed" });
    return;
  }
  if (!outcome.stuck) return;
  emitInvocation(push, state, at + 50_000, "reviewer", `${state.id}-r${index}`, true, {
    note: "request_changes：refresh() 存在并发竞态。",
  });
  push(at + 95_000, "run.wave.completed", { taskIds: [item.task.id], status: "blocked" });
  push(at + 100_000, "run.advisor.consulted", {
    trigger: "repeated-failure",
    recommendation: "stop",
    summary: "竞态需要重新设计刷新协议，继续重试收益低。",
  });
}

function emitInvocation(
  push: EventPusher,
  state: RunState,
  at: number,
  role: string,
  invocationId: string,
  success: boolean | undefined,
  options: { note?: string } = {},
): void {
  const profile = state.strategy.roleProfiles[role] ?? "default";
  const adapter = profile.startsWith("claude") ? "claude" : "codex";
  push(at, "agent.invocation.started", { role, profile, adapter, invocationId, model: profile });
  if (options.note) {
    push(at + 4_000, "agent.stdout", { invocationId, text: `${options.note}\n` });
  }
  if (success === undefined) return;
  push(at + 40_000, "agent.invocation.completed", {
    role,
    profile,
    adapter,
    invocationId,
    success,
    model: profile,
  });
}

function emitApprovals(push: EventPusher, state: RunState): void {
  for (const approval of state.approvals ?? []) {
    push(Date.parse(approval.requestedAt), "approval.requested", {
      gate: approval.gate,
      requestId: approval.id,
    });
  }
}

function emitTerminalStatus(push: EventPusher, state: RunState): void {
  if (state.status !== "blocked" && state.status !== "ci-failed") return;
  push(Date.parse(state.updatedAt), "run.updated", { status: state.status });
}

export function buildEvidence(run: DemoRun): RunEvidence {
  const { state } = run;
  return {
    runId: state.id,
    status: state.status,
    readiness: readinessOf(state),
    checks: checksOf(state),
    tasks: state.tasks.map(taskEvidence),
    artifacts: EVIDENCE_ARTIFACTS,
    artifactBytes: state.usage?.artifactBytes ?? 0,
    diff: diffOf(run),
  };
}

/** Anything that failed needs attention; a finished or gated run is ready. */
function readinessOf(state: RunState): RunEvidence["readiness"] {
  if (isFailed(state)) return "attention";
  if (state.status === "completed" || hasPendingApproval(state)) return "ready";
  return "in-progress";
}

function isFailed(state: RunState): boolean {
  return state.status === "blocked" || state.status === "ci-failed";
}

function hasPendingApproval(state: RunState): boolean {
  return (state.approvals ?? []).some((approval) => approval.status === "pending");
}

function checksOf(state: RunState): RunEvidence["checks"] {
  return [
    tasksCheck(state),
    qualityCheck(state),
    decisionCheck(state),
    approvalCheck(state),
  ];
}

function tasksCheck(state: RunState): RunEvidence["checks"][number] {
  const finished = state.tasks.filter(
    (item) => item.status === "merged" || item.status === "passed",
  ).length;
  const total = state.tasks.length;
  return {
    id: "tasks",
    label: "任务",
    status: finished === total && total > 0 ? "pass" : isFailed(state) ? "fail" : "pending",
    detail: `${finished}/${total} 个任务已通过`,
  };
}

function qualityCheck(state: RunState): RunEvidence["checks"][number] {
  const quality = state.finalQuality;
  return {
    id: "quality",
    label: "确定性检查",
    status: quality ? (quality.passed ? "pass" : "fail") : "pending",
    detail: quality ? "check / test / lint" : "尚未运行",
  };
}

function decisionCheck(state: RunState): RunEvidence["checks"][number] {
  return {
    id: "decision",
    label: "总控裁决",
    status: state.finalDecision ? "pass" : "pending",
    detail: state.finalDecision?.reason ?? "等待裁决",
  };
}

function approvalCheck(state: RunState): RunEvidence["checks"][number] {
  const pending = hasPendingApproval(state);
  return {
    id: "approval",
    label: "人工审批",
    status: !pending && state.status === "completed" ? "pass" : "pending",
    detail: pending ? "等待你确认" : "无需审批",
  };
}

function taskEvidence(item: RunState["tasks"][number]): RunEvidence["tasks"][number] {
  return {
    id: item.task.id,
    title: item.task.title,
    status: item.status,
    attempts: item.attempts,
    ...(item.commit ? { commit: item.commit } : {}),
    ...(item.quality ? { qualityPassed: item.quality.passed } : {}),
    ...(item.review ? { reviewVerdict: item.review.verdict } : {}),
    ...(item.test ? { testVerdict: item.test.verdict } : {}),
    findingCount: item.review?.findings.length ?? 0,
  };
}

const EVIDENCE_ARTIFACTS: RunEvidence["artifacts"] = [
  { path: "plan/architect-output.md", size: 3_200, kind: "agent-output", previewable: true },
  { path: "quality/final.json", size: 1_900, kind: "quality", previewable: true },
];

function diffOf(run: DemoRun): RunEvidence["diff"] {
  const base = {
    available: run.diff.length > 0,
    baseCommit: "9a1b2c3",
    changedFiles: run.changedFiles,
    truncated: false,
  };
  if (!run.diff) return { ...base, detail: "该运行尚未产生可对比的集成提交" };
  return { ...base, targetCommit: "e4f5a6b", content: run.diff };
}

const USAGE_FIELDS = [
  "agentInvocations",
  "agentDurationMs",
  "processOutputBytes",
  "truncatedStreams",
  "artifactBytes",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reportedCostUsd",
] as const;

type UsageField = (typeof USAGE_FIELDS)[number];
type UsageTotals = Record<UsageField, number> & { costReported: boolean };

function zeroTotals(): UsageTotals {
  const totals = { costReported: true } as UsageTotals;
  for (const field of USAGE_FIELDS) totals[field] = 0;
  return totals;
}

/** One run's usage, with every missing counter read as zero. */
function usageOf(usage: RunState["usage"]): Record<UsageField, number> {
  const detail = {} as Record<UsageField, number>;
  for (const field of USAGE_FIELDS) detail[field] = usage?.[field] ?? 0;
  return detail;
}

function addUsage(totals: UsageTotals, detail: Record<UsageField, number>): void {
  for (const field of USAGE_FIELDS) totals[field] += detail[field];
}

export function buildUsage(runs: DemoRun[]): UsageReport {
  const totals = zeroTotals();
  const entries = runs.map(({ state }) => {
    const detail = usageOf(state.usage);
    addUsage(totals, detail);
    return {
      runId: state.id,
      goal: state.goal,
      status: state.status,
      strategy: state.strategy.name,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      usage: { ...detail, costReported: true },
    };
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
