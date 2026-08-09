#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { stringify as stringifyYaml } from "yaml";
import { createDefaultConfig } from "./config/defaults.js";
import { loadConfig } from "./config/load.js";
import { resolveProfile } from "./profiles/resolve.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { invokeAgent } from "./adapters/invoke.js";
import { runDoctor } from "./doctor.js";
import { LocalWorkflowRunner } from "./workflow/runner.js";
import { StrategyBlueprintCatalog } from "./strategies/catalog.js";
import { RunStateStore } from "./state/store.js";
import { SqliteEventStore } from "./events/store.js";
import { filterRunEvents, renderLogLines } from "./logs/render.js";
import type { RunLogFilter } from "./logs/render.js";
import { GithubPublisher } from "./github/publish.js";
import { GithubRepairRunner } from "./github/repair.js";
import type { LoadedConfig } from "./config/load.js";
import { startControlService } from "./server/start.js";
import { startProjectRuntime } from "./server/project-runtime.js";
import { loadWorkspace } from "./workspace/load.js";
import { startWorkspaceControlService } from "./workspace/service.js";
import { assertDiagnosticProfilePermission } from "./security/permissions.js";
import { buildInteropManifest } from "./interop/manifest.js";

const program = new Command();
program
  .name("agent-team")
  .description("Local-first orchestration for software-development agents")
  .version("0.1.0");

program
  .command("init")
  .description("Create an agent-team.yaml in a project")
  .argument("[directory]", "project directory", ".")
  .option("--force", "replace an existing configuration", false)
  .action(async (directory: string, options: { force: boolean }) => {
    const root = path.resolve(directory);
    const target = path.join(root, "agent-team.yaml");
    if (!options.force) {
      try {
        await readFile(target, "utf8");
        throw new Error(`${target} already exists; use --force to replace it`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
          throw error;
        }
      }
    }
    const config = createDefaultConfig(path.basename(root));
    await writeFile(target, stringifyYaml(config), "utf8");
    process.stdout.write(`Created ${target}\n`);
  });

program
  .command("validate")
  .description("Validate project or workspace configuration")
  .option("-c, --config <path>", "configuration path")
  .option("-w, --workspace <path>", "workspace manifest path")
  .action(async (options: { config?: string; workspace?: string }) => {
    assertExclusiveConfigOptions(options);
    if (options.workspace) {
      const workspace = await loadWorkspace(process.cwd(), options.workspace);
      process.stdout.write(`Valid: ${workspace.path} (${workspace.projects.length} projects)\n`);
      return;
    }
    const loaded = await loadConfig(process.cwd(), options.config);
    process.stdout.write(`Valid: ${loaded.path}\n`);
  });

program
  .command("profiles")
  .description("List configured profiles and role defaults")
  .option("-c, --config <path>", "configuration path")
  .option("--json", "emit JSON", false)
  .action(async (options: { config?: string; json: boolean }) => {
    const loaded = await loadConfig(process.cwd(), options.config);
    const output = Object.entries(loaded.config.roles).map(([role, policy]) => ({
      role,
      defaultProfile: policy.defaultProfile,
      allowedProfiles: policy.allowedProfiles,
      fallbackProfiles: policy.fallbackProfiles,
    }));
    if (options.json) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return;
    }
    for (const item of output) {
      process.stdout.write(
        `${item.role.padEnd(14)} ${item.defaultProfile} [${item.allowedProfiles.join(", ")}]\n`,
      );
    }
  });

program
  .command("interop")
  .description("Show adapter contracts and external protocol boundaries")
  .option("-c, --config <path>", "configuration path")
  .option("--json", "emit JSON", false)
  .action(async (options: { config?: string; json: boolean }) => {
    const loaded = await loadConfig(process.cwd(), options.config);
    const manifest = buildInteropManifest(loaded.config);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      return;
    }
    for (const adapter of manifest.adapters) {
      process.stdout.write(
        `${adapter.name}\tcontract=v${adapter.contractVersion}\t${adapter.transport}\tstructured=${String(adapter.structuredOutput)}\n`,
      );
    }
    process.stdout.write(
      `mcp\t${manifest.protocols.mcp.specification}\t${manifest.protocols.mcp.mode}\tdefault=${manifest.protocols.mcp.defaultPolicy}\n`,
    );
    process.stdout.write(
      `a2a\t${manifest.protocols.a2a.specification}\t${manifest.protocols.a2a.mode}\n`,
    );
  });

program
  .command("doctor")
  .description("Check configured agent CLIs, authentication, and capabilities")
  .option("-c, --config <path>", "configuration path")
  .option("--profile <name>", "check one profile")
  .option("--probe-models", "perform real model calls", false)
  .option("--json", "emit JSON", false)
  .action(
    async (options: {
      config?: string;
      profile?: string;
      probeModels: boolean;
      json: boolean;
    }) => {
      const loaded = await loadConfig(process.cwd(), options.config);
      const checks = await runDoctor(loaded, {
        probeModel: options.probeModels,
        ...(options.profile ? { profileName: options.profile } : {}),
      });
      if (options.json) {
        process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
      } else {
        for (const check of checks) {
          process.stdout.write(
            `${check.status.toUpperCase().padEnd(5)} ${check.profile}/${check.check}: ${check.detail}\n`,
          );
        }
      }
      if (checks.some((check) => check.status === "fail")) {
        process.exitCode = 1;
      }
    },
  );

program
  .command("invoke")
  .description("Invoke one configured role for adapter verification")
  .requiredOption("--role <name>", "role to invoke")
  .requiredOption("--prompt <text>", "task prompt")
  .option("--profile <name>", "allowed profile override")
  .option("--schema <path>", "JSON Schema for structured output")
  .option("-c, --config <path>", "configuration path")
  .action(
    async (options: {
      role: string;
      prompt: string;
      profile?: string;
      schema?: string;
      config?: string;
    }) => {
      const loaded = await loadConfig(process.cwd(), options.config);
      const resolved = resolveProfile(loaded.config, options.role, options.profile);
      assertDiagnosticProfilePermission(
        options.role,
        resolved.name,
        resolved.profile.permission,
      );
      const outputSchema = options.schema
        ? (JSON.parse(await readFile(path.resolve(options.schema), "utf8")) as Record<string, unknown>)
        : undefined;
      const artifactDirectory = path.join(
        loaded.root,
        loaded.config.project.stateDirectory,
        "invocations",
        `${Date.now()}-${options.role}`,
      );
      const result = await invokeAgent(
        {
          adapterName: resolved.profile.adapter,
          profile: resolved.profile,
          cwd: loaded.root,
          prompt: options.prompt,
          artifactDirectory,
          ...(outputSchema ? { outputSchema } : {}),
        },
        new AdapterRegistry(),
      );
      process.stdout.write(`${result.text}\n`);
    },
  );

program
  .command("run")
  .description("Run the local multi-agent development workflow")
  .requiredOption("--goal <text>", "software-development goal")
  .option(
    "--profile <role=profile>",
    "override a role profile; repeat for multiple roles",
    collectOption,
    [],
  )
  .option("--strategy <name>", "named execution strategy")
  .option("-c, --config <path>", "configuration path")
  .action(
    async (options: {
      goal: string;
      profile: string[];
      strategy?: string;
      config?: string;
    }) => {
      const catalog = await StrategyBlueprintCatalog.open(
        await loadConfig(process.cwd(), options.config),
      );
      const profileOverrides = parseProfileAssignments(options.profile);
      const state = await new LocalWorkflowRunner(catalog.loaded).run({
        goal: options.goal,
        profileOverrides,
        ...(options.strategy ? { strategyName: options.strategy } : {}),
      });
      process.stdout.write(
        `${state.id}\t${state.status}\t${state.integrationBranch}\n`,
      );
      if (state.error) {
        process.stderr.write(`${state.error}\n`);
      }
      if (state.status === "blocked") {
        process.exitCode = 1;
      }
    },
  );

program
  .command("serve")
  .description("Start the local REST and SSE control service for a project or workspace")
  .option("--host <host>", "loopback host", "127.0.0.1")
  .option("--port <port>", "listen port", "4317")
  .option("-c, --config <path>", "configuration path")
  .option("-w, --workspace <path>", "workspace manifest path")
  .action(async (options: { host: string; port: string; config?: string; workspace?: string }) => {
    assertExclusiveConfigOptions(options);
    const port = parsePort(options.port);
    const sessionToken = process.env.AGENT_TEAM_SESSION_TOKEN;
    const service = options.workspace
      ? await startWorkspaceControlService(
          await loadWorkspace(process.cwd(), options.workspace),
          { host: options.host, port, ...(sessionToken ? { sessionToken } : {}) },
        )
      : await startControlService(await loadConfig(process.cwd(), options.config), {
          host: options.host,
          port,
          ...(sessionToken ? { sessionToken } : {}),
        });
    process.stdout.write(
      `Agent Team ${options.workspace ? "workspace " : ""}control service: ${service.url}\n`,
    );
    await waitForShutdownSignal();
    await service.close();
  });

program
  .command("approval")
  .description("Approve or reject a pending durable approval request")
  .argument("<run-id>", "run identifier")
  .requiredOption("--request <id>", "approval request identifier")
  .requiredOption("--decision <decision>", "approved or rejected")
  .requiredOption("--actor <name>", "human actor recorded in the audit trail")
  .requiredOption("--reason <text>", "approval or rejection reason")
  .option("-c, --config <path>", "configuration path")
  .action(
    async (
      runId: string,
      options: {
        request: string;
        decision: string;
        actor: string;
        reason: string;
        config?: string;
      },
    ) => {
      if (options.decision !== "approved" && options.decision !== "rejected") {
        throw new Error("--decision must be 'approved' or 'rejected'");
      }
      const runtime = await startProjectRuntime(await loadConfig(process.cwd(), options.config));
      try {
        const result = await runtime.supervisor.respondApproval(runId, {
          requestId: options.request,
          decision: options.decision,
          actor: options.actor,
          reason: options.reason,
        });
        if (result.status === "resuming") {
          await runtime.supervisor.wait(runId);
        }
        const state = await runtime.supervisor.get(runId);
        process.stdout.write(`${runId}\t${state?.status ?? result.status}\n`);
      } finally {
        await runtime.close();
      }
    },
  );

program
  .command("resume")
  .description("Resume an interrupted run from its latest verified checkpoint")
  .argument("<run-id>", "run identifier")
  .requiredOption("--actor <name>", "human actor recorded in the audit trail")
  .requiredOption("--reason <text>", "recovery reason")
  .option("-c, --config <path>", "configuration path")
  .action(
    async (
      runId: string,
      options: { actor: string; reason: string; config?: string },
    ) => {
      const runtime = await startProjectRuntime(await loadConfig(process.cwd(), options.config));
      try {
        await runtime.supervisor.resume(runId, {
          actor: options.actor,
          reason: options.reason,
        });
        await runtime.supervisor.wait(runId);
        const state = await runtime.supervisor.get(runId);
        process.stdout.write(`${runId}\t${state?.status ?? "unknown"}\n`);
      } finally {
        await runtime.close();
      }
    },
  );

program
  .command("status")
  .description("Show one run or list recent runs")
  .argument("[run-id]", "run identifier")
  .option("-c, --config <path>", "configuration path")
  .option("--json", "emit JSON", false)
  .action(async (runId: string | undefined, options: { config?: string; json: boolean }) => {
    const loaded = await loadConfig(process.cwd(), options.config);
    const runsDirectory = path.resolve(
      loaded.root,
      loaded.config.project.stateDirectory,
      "runs",
    );
    const store = new RunStateStore(runsDirectory);
    if (runId) {
      const state = await store.load(runId);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${state.id} ${state.status}\n`);
      for (const task of state.tasks) {
        process.stdout.write(
          `  ${task.task.id.padEnd(12)} ${task.status.padEnd(10)} attempts=${task.attempts}\n`,
        );
      }
      const checkpoint = state.checkpoints?.at(-1);
      if (checkpoint) {
        process.stdout.write(
          `  checkpoint: ${checkpoint.id} ${checkpoint.stage} ${checkpoint.integrationCommit.slice(0, 10)}\n`,
        );
      }
      for (const approval of state.approvals?.filter((item) => item.status === "pending") ?? []) {
        process.stdout.write(
          `  approval: ${approval.id} gate=${approval.gate} expires=${approval.expiresAt}\n`,
        );
      }
      if (state.error) {
        process.stdout.write(`  error: ${state.error}\n`);
      }
      return;
    }
    const states = await store.list();
    if (options.json) {
      process.stdout.write(`${JSON.stringify(states, null, 2)}\n`);
      return;
    }
    for (const state of states) {
      process.stdout.write(`${state.id}\t${state.status}\t${state.updatedAt}\n`);
    }
  });

program
  .command("logs")
  .description("Print the recorded event stream of one run")
  .argument("<run-id>", "run identifier")
  .option("-c, --config <path>", "configuration path")
  .option("--json", "emit raw event JSON lines", false)
  .option("--role <name>", "only show events of one role")
  .option("--type <prefix>", "only show event types starting with a prefix")
  .option("--tail <n>", "only show the last n events")
  .action(
    async (
      runId: string,
      options: {
        config?: string;
        json: boolean;
        role?: string;
        type?: string;
        tail?: string;
      },
    ) => {
      const loaded = await loadConfig(process.cwd(), options.config);
      const databasePath = path.join(
        path.resolve(loaded.root, loaded.config.project.stateDirectory),
        "control.sqlite",
      );
      if (!existsSync(databasePath)) {
        throw new Error(`No event store found at ${databasePath}; no runs have been recorded`);
      }
      const filter: RunLogFilter = {
        ...(options.role ? { role: options.role } : {}),
        ...(options.type ? { typePrefix: options.type } : {}),
        ...(options.tail !== undefined ? { tail: parseTail(options.tail) } : {}),
      };
      const store = new SqliteEventStore(databasePath);
      try {
        const events = filterRunEvents(store.listRunEvents(runId), filter);
        if (options.json) {
          for (const event of events) {
            process.stdout.write(`${JSON.stringify(event)}\n`);
          }
          return;
        }
        for (const line of renderLogLines(events)) {
          process.stdout.write(`${line}\n`);
        }
      } finally {
        store.close();
      }
    },
  );

program
  .command("publish")
  .description("Push a passing integration branch and create a draft pull request")
  .argument("<run-id>", "run identifier")
  .option("-c, --config <path>", "configuration path")
  .option("--wait", "wait for GitHub checks", false)
  .action(async (runId: string, options: { config?: string; wait: boolean }) => {
    const { loaded, store } = await loadRunContext(options.config);
    const state = await store.load(runId);
    const publisher = new GithubPublisher(loaded, store);
    await publisher.publish(state);
    process.stdout.write(`${state.pullRequestUrl}\n`);
    if (options.wait) {
      const checks = await publisher.refreshChecks(state, true);
      printChecks(checks);
      if (state.status === "ci-failed") {
        process.exitCode = 1;
      }
    }
  });

program
  .command("checks")
  .description("Refresh GitHub Actions status for a published run")
  .argument("<run-id>", "run identifier")
  .option("-c, --config <path>", "configuration path")
  .option("--watch", "wait until checks complete", false)
  .action(async (runId: string, options: { config?: string; watch: boolean }) => {
    const { loaded, store } = await loadRunContext(options.config);
    const state = await store.load(runId);
    const checks = await new GithubPublisher(loaded, store).refreshChecks(
      state,
      options.watch,
    );
    printChecks(checks);
    if (state.status === "ci-failed") {
      process.exitCode = 1;
    }
  });

program
  .command("repair")
  .description("Run one bounded local repair for failed GitHub checks")
  .argument("<run-id>", "run identifier")
  .option("-c, --config <path>", "configuration path")
  .action(async (runId: string, options: { config?: string }) => {
    const { loaded, store } = await loadRunContext(options.config);
    const state = await store.load(runId);
    await new GithubRepairRunner(loaded, store).repair(state);
    process.stdout.write(`${state.id}\t${state.status}\n`);
    if (state.status === "ci-failed") {
      process.exitCode = 1;
    }
  });

program
  .command("complete")
  .description("Mark a run complete after its pull request is merged")
  .argument("<run-id>", "run identifier")
  .option("-c, --config <path>", "configuration path")
  .action(async (runId: string, options: { config?: string }) => {
    const { loaded, store } = await loadRunContext(options.config);
    const state = await store.load(runId);
    const merged = await new GithubPublisher(loaded, store).markCompletedIfMerged(state);
    if (!merged) {
      throw new Error(`Pull request for run '${runId}' has not been merged`);
    }
    process.stdout.write(`${state.id}\tcompleted\n`);
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});

function parseProfileAssignments(assignments: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    if (separator <= 0 || separator === assignment.length - 1) {
      throw new Error(`Invalid profile assignment '${assignment}'; expected role=profile`);
    }
    result[assignment.slice(0, separator)] = assignment.slice(separator + 1);
  }
  return result;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function loadRunContext(configPath?: string): Promise<{
  loaded: LoadedConfig;
  store: RunStateStore;
}> {
  const loaded = await loadConfig(process.cwd(), configPath);
  const runsDirectory = path.resolve(
    loaded.root,
    loaded.config.project.stateDirectory,
    "runs",
  );
  return { loaded, store: new RunStateStore(runsDirectory) };
}

function printChecks(checks: Array<{ bucket: string; name: string; state: string }>): void {
  if (checks.length === 0) {
    process.stdout.write("No GitHub checks reported.\n");
    return;
  }
  for (const check of checks) {
    process.stdout.write(`${check.bucket.toUpperCase().padEnd(8)} ${check.name}: ${check.state}\n`);
  }
}

function parseTail(value: string): number {
  const tail = Number(value);
  if (!Number.isInteger(tail) || tail < 0) {
    throw new Error(`Invalid --tail value '${value}'; expected a non-negative integer`);
  }
  return tail;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port '${value}'`);
  }
  return port;
}

function assertExclusiveConfigOptions(options: { config?: string; workspace?: string }): void {
  if (options.config && options.workspace) {
    throw new Error("Use either --config or --workspace, not both");
  }
}

async function waitForShutdownSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}
