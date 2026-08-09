import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { createDefaultConfig } from "../../src/config/defaults.js";
import { SqliteEventStore } from "../../src/events/store.js";
import type { RunState, TaskRunState } from "../../src/state/types.js";
import { loadWorkspace } from "../../src/workspace/load.js";
import { startWorkspaceControlService } from "../../src/workspace/service.js";
import { compileStrategyTopology } from "../../src/strategies/topology.js";

const root = await mkdtemp(path.join(tmpdir(), "agent-team-ui-e2e-"));
const visualRoot = path.join(root, "visual");
const serviceRoot = path.join(root, "service");
await mkdir(visualRoot, { recursive: true });
await mkdir(serviceRoot, { recursive: true });
const config = createDefaultConfig("visual-fixture");
config.profiles["claude-reviewer"] = {
  adapter: "claude",
  model: "inherit",
  reasoning: "high",
  permission: "read-only",
  externalTools: "deny",
  timeoutSeconds: 900,
  args: [],
};
config.roles.architect!.allowedProfiles.push("claude-reviewer");
config.profiles["codex-worker"]!.externalTools = "inherit";
config.roles.reviewer = {
  defaultProfile: "claude-reviewer",
  allowedProfiles: ["claude-reviewer", "codex-planner"],
  fallbackProfiles: ["codex-planner"],
};
config.strategies!.definitions.strict = {
  topology: { mode: "sequential" },
  maxParallel: 1,
  maxReworkAttempts: 3,
  roleProfiles: {
    architect: "claude-reviewer",
    reviewer: "claude-reviewer",
    tester: "codex-planner",
  },
};
await writeFile(path.join(visualRoot, "agent-team.yaml"), stringifyYaml(config), "utf8");
await writeFile(
  path.join(serviceRoot, "agent-team.yaml"),
  stringifyYaml(createDefaultConfig("service-fixture")),
  "utf8",
);

const state = fixtureState(visualRoot);
// 标记为其他控制服务持有的活跃运行：服务启动时的崩溃恢复会把它转为
// interrupted（可重试、证据就绪度需要处理），与既有 e2e 断言保持一致。
state.supervisorId = "fixture-stale-supervisor";
const runDirectory = path.join(visualRoot, ".agent-team", "runs", state.id);
await mkdir(runDirectory, { recursive: true });
await writeFile(path.join(runDirectory, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
const qualityArtifacts = path.join(
  runDirectory,
  "artifacts",
  "tasks",
  "refund-api",
  "attempt-2",
  "quality",
);
await mkdir(qualityArtifacts, { recursive: true });
await writeFile(
  path.join(qualityArtifacts, "1.log"),
  "$ pnpm test\nexit: 0\n\nrefund idempotency regression passed\n",
  "utf8",
);
const reviewArtifacts = path.join(
  runDirectory,
  "artifacts",
  "tasks",
  "refund-api",
  "attempt-2",
  "review",
  "claude-reviewer",
);
await mkdir(reviewArtifacts, { recursive: true });
await writeFile(
  path.join(reviewArtifacts, "last-message.json"),
  `${JSON.stringify({ verdict: "approve", summary: "Idempotency boundary is explicit" }, null, 2)}\n`,
  "utf8",
);

const serviceState = fixtureState(serviceRoot);
serviceState.id = "run-service-20260808";
serviceState.goal = "校验跨服务接口契约与发布边界";
serviceState.integrationBranch = "agent-team/run-service/integration";
serviceState.status = "awaiting-human";
serviceState.tasks = [fixtureTask("contract", "接口契约", [], "merged", 1)];
serviceState.plan = {
  summary: "独立校验服务接口契约，不读取其他项目的运行数据。",
  tasks: serviceState.tasks.map((task) => task.task),
};
serviceState.finalDecision = { decision: "ready", reason: "接口契约和本地门禁已通过" };
serviceState.checkpoints = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    version: 1,
    stage: "local-gates-passed",
    integrationCommit: "7f93c1a",
    completedTaskIds: ["contract"],
    createdAt: new Date().toISOString(),
  },
];
serviceState.approvals = [
  {
    id: "00000000-0000-4000-8000-000000000002",
    gate: "final",
    status: "pending",
    summary: "本地门禁已通过，确认交付结果",
    checkpointId: serviceState.checkpoints[0]!.id,
    requestedAt: new Date().toISOString(),
    expiresAt: "2099-08-08T12:00:00.000Z",
  },
];
const serviceRunDirectory = path.join(serviceRoot, ".agent-team", "runs", serviceState.id);
await mkdir(serviceRunDirectory, { recursive: true });
await writeFile(
  path.join(serviceRunDirectory, "state.json"),
  `${JSON.stringify(serviceState, null, 2)}\n`,
  "utf8",
);

const events = new SqliteEventStore(path.join(visualRoot, ".agent-team", "control.sqlite"));
events.emit(state.id, "agent.stdout", {
  role: "worker",
  profile: "codex-worker",
  artifactKey: "tasks/refund-api/attempt-2/worker",
  chunk: "implemented refund idempotency ledger\n",
});
events.emit(state.id, "agent.stderr", {
  role: "tester",
  profile: "codex-planner",
  artifactKey: "tasks/refund-api/attempt-2/test",
  chunk: "running targeted regression suite\n",
});
events.close();

await writeFile(
  path.join(root, "agent-team.workspace.yaml"),
  stringifyYaml({
    version: 1,
    projects: [
      { id: "visual", config: "./visual/agent-team.yaml" },
      { id: "service", config: "./service/agent-team.yaml" },
    ],
  }),
  "utf8",
);
const workspace = await loadWorkspace(root);
const service = await startWorkspaceControlService(workspace, { port: 4399 });
process.stdout.write(`Visual fixture: ${service.url}\n`);
await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await service.close();

function fixtureState(projectRoot: string): RunState {
  const now = new Date().toISOString();
  const tasks = [
    fixtureTask("ledger", "幂等账本", [], "merged", 1),
    fixtureTask("refund-api", "退款 API", ["ledger"], "passed", 2),
    fixtureTask("ops-ui", "运营审计界面", ["ledger"], "working", 1),
    fixtureTask("release", "回归与交付", ["refund-api", "ops-ui"], "pending", 0),
  ];
  return {
    id: "run-visual-20260808",
    goal: "实现订单退款幂等控制并提供可视化审计",
    root: projectRoot,
    configPath: path.join(projectRoot, "agent-team.yaml"),
    baseBranch: "main",
    baseCommit: "4c27a61",
    integrationBranch: "agent-team/run-visual/integration",
    integrationWorktree: path.join(projectRoot, "worktree"),
    status: "reviewing-testing",
    createdAt: now,
    updatedAt: now,
    profileOverrides: { worker: "codex-worker" },
    strategy: {
      name: "balanced",
      maxParallel: 2,
      maxReworkAttempts: 2,
      executionTimeoutSeconds: 14_400,
      maxAgentInvocations: 64,
      maxProcessOutputBytes: 1_048_576,
      maxArtifactBytes: 1_073_741_824,
      roleProfiles: {},
      approvalGates: ["final"],
      approvalTimeoutSeconds: 86_400,
      topology: compileStrategyTopology("parallel-dag", ["final"]),
    },
    traceId: "92cf2896e58c4aa3a63dc1cc7ed949b6",
    usage: {
      agentInvocations: 11,
      agentDurationMs: 184_000,
      processOutputBytes: 482_410,
      truncatedStreams: 0,
      artifactBytes: 2_840_128,
      inputTokens: 48_220,
      cachedInputTokens: 9_110,
      outputTokens: 8_430,
      reportedCostUsd: 0.4187,
    },
    plan: {
      summary: "拆分持久化、退款 API、管理界面和交付文档，并按依赖波次执行。",
      tasks: tasks.map((task) => task.task),
    },
    tasks,
    history: [
      { at: now, status: "created", message: "Run created" },
      { at: now, status: "architecting", message: "Architect is producing a task DAG" },
      { at: now, status: "planned", message: "Architect produced 4 task(s)" },
      { at: now, status: "implementing", message: "Starting worker wave: refund-api, ops-ui" },
      {
        at: now,
        status: "reviewing-testing",
        message: "Reviewing and testing task refund-api, attempt 2",
      },
    ],
  };
}

function fixtureTask(
  id: string,
  title: string,
  dependsOn: string[],
  status: TaskRunState["status"],
  attempts: number,
): TaskRunState {
  const completed = status === "passed" || status === "merged";
  return {
    task: {
      id,
      title,
      description: `实现 ${title}，保持边界清晰并补齐验证。`,
      dependsOn,
      ownedPaths: [`src/${id}/**`],
      acceptanceCommands: [{ command: "pnpm", args: ["test"] }],
      profile: null,
    },
    status,
    attempts,
    profile: "codex-worker",
    ...(status !== "pending"
      ? {
          quality: {
            passed: true,
            commands: [
              {
                spec: { command: "pnpm", args: ["test"] },
                exitCode: 0,
                stdout: "",
                stderr: "",
                durationMs: 842,
                timedOut: false,
              },
            ],
          },
        }
      : {}),
    ...(completed
      ? {
          review: {
            verdict: "approve" as const,
            summary: "实现边界清晰，未发现阻断问题。",
            findings: [],
          },
          test: {
            verdict: "approve" as const,
            summary: "目标测试和回归测试通过。",
            missingTests: [],
          },
        }
      : {}),
  };
}
