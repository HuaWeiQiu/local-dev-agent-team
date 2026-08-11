import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentInvocationObserver } from "../src/agents/service.js";
import { ProfiledAgentService } from "../src/agents/service.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { CodexActivityParser } from "../src/adapters/codex-events.js";
import type { AgentAdapter } from "../src/adapters/types.js";
import { createDefaultConfig } from "../src/config/defaults.js";
import type { AgentTeamConfig } from "../src/config/schema.js";
import { RunBudgetExceededError } from "../src/observability/budget.js";
import type { RunStateStore } from "../src/state/store.js";

const answerSchema = z.object({ answer: z.string() });
const answerJsonSchema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
};

describe("ProfiledAgentService fallback chain", () => {
  it("continues with the fallback profile after the primary fails", async () => {
    const fixture = await createFixture();

    const response = await fixture.service.runStructured({
      role: "worker",
      context: { case: "fallback" },
      runId: "run-fallback",
      artifactKey: "fallback/structured",
      schema: answerSchema,
      jsonSchema: answerJsonSchema,
    });

    expect(response.value).toEqual({ answer: "from-fallback" });
    expect(response.profileName).toBe("fallback-worker");
    expect(response.usedFallback).toBe(true);
    expect(fixture.models).toEqual(["boom", "ok"]);
  });

  it("aggregates every profile error when the whole chain fails", async () => {
    const fixture = await createFixture({ failFallback: true });

    const error = await fixture.service
      .runText({
        role: "worker",
        context: { case: "all-fail" },
        runId: "run-all-fail",
        artifactKey: "fallback/all-fail",
      })
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("All profiles failed for role 'worker'");
    expect((error as Error).message).toContain("primary-worker:");
    expect((error as Error).message).toContain("fallback-worker:");
    expect(fixture.models).toEqual(["boom", "boom"]);
  });

  it("aborts without invoking any adapter when the observer rejects the invocation", async () => {
    const observer = failingObserver(new Error("budget ledger unavailable"));
    const fixture = await createFixture({ observer });

    await expect(
      fixture.service.runText({
        role: "worker",
        context: { case: "observer-rejects" },
        runId: "run-observer",
        artifactKey: "fallback/observer",
      }),
    ).rejects.toThrow("budget ledger unavailable");
    // Neither the primary nor the fallback adapter was started.
    expect(fixture.models).toEqual([]);
    expect(observer.afterCalls).toBe(0);
  });

  it("stops the fallback chain when the execution budget aborts the signal", async () => {
    const controller = new AbortController();
    controller.abort(new RunBudgetExceededError("Execution timeout of 5 seconds exceeded"));
    const fixture = await createFixture({ signal: controller.signal });

    await expect(
      fixture.service.runText({
        role: "worker",
        context: { case: "budget-abort" },
        runId: "run-budget",
        artifactKey: "fallback/budget",
      }),
    ).rejects.toBeInstanceOf(RunBudgetExceededError);
    // The primary candidate was prepared but the fallback was never attempted.
    expect(fixture.models).toEqual(["boom"]);
  });

  it("binds normalized child activity to the controller-owned invocation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-activity-"));
    const config = fallbackConfig(false);
    config.profiles["primary-worker"]!.model = "ok";
    const emitted: Array<{ runId: string; type: string; payload: unknown }> = [];
    const store = {
      artifactDirectory: (runId: string, ...parts: string[]) =>
        path.join(root, runId, "artifacts", ...parts),
      emit: (runId: string, type: string, payload: unknown) => {
        emitted.push({ runId, type, payload });
      },
    };
    const adapter: AgentAdapter = {
      name: "fixture",
      contract: {
        version: 1,
        transport: "local-process",
        permissions: ["read-only", "workspace-write"],
        externalTools: ["deny"],
        structuredOutput: true,
        usage: [],
      },
      supportedReasoning: ["medium"],
      createActivityParser: () => new CodexActivityParser(),
      buildInvocation: (_profile, request) => ({
        command: process.execPath,
        args: ["-e", `process.stdout.write(${JSON.stringify(`${JSON.stringify({
          type: "item.completed",
          item: {
            type: "collab_tool_call",
            tool: "wait",
            status: "completed",
            receiver_thread_ids: ["thread-child"],
            agents_states: { "thread-child": { status: "completed" } },
          },
        })}\n`)})`],
        cwd: request.cwd,
        stdin: request.prompt,
        timeoutMs: 1_000,
      }),
      parseResult: async (_invocation, processResult) => ({
        text: processResult.stdout,
        process: processResult,
      }),
      doctor: async () => [],
    };
    const observer: AgentInvocationObserver = {
      beforeInvocation: async () => "invocation-owned",
      afterInvocation: async () => {},
    };
    const service = new ProfiledAgentService(
      config,
      root,
      store as unknown as RunStateStore,
      {},
      undefined,
      observer,
      new AdapterRegistry([adapter]),
    );

    await service.runText({
      role: "worker",
      context: { case: "native-child" },
      runId: "run-native-child",
      artifactKey: "worker/native-child",
    });

    expect(emitted.find((event) => event.type === "agent.children.updated")).toEqual({
      runId: "run-native-child",
      type: "agent.children.updated",
      payload: {
        invocationId: "invocation-owned",
        role: "worker",
        profile: "primary-worker",
        adapter: "fixture",
        artifactKey: "worker/native-child",
        agents: [{ threadId: "thread-child", status: "completed" }],
      },
    });
  });
});

function failingObserver(error: Error) {
  const observer = {
    afterCalls: 0,
    beforeInvocation: async (): Promise<string> => {
      throw error;
    },
    afterInvocation: async (): Promise<void> => {
      observer.afterCalls += 1;
    },
  };
  return observer;
}

async function createFixture(
  options: {
    failFallback?: boolean;
    observer?: AgentInvocationObserver;
    signal?: AbortSignal;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-fallback-"));
  const config = fallbackConfig(options.failFallback === true);
  const models: string[] = [];
  const adapter = fixtureAdapter(models);
  const store = fakeStore(path.join(root, "artifacts"));
  const service = new ProfiledAgentService(
    config,
    root,
    store as unknown as RunStateStore,
    {},
    options.signal,
    options.observer,
    new AdapterRegistry([adapter]),
  );
  return { service, models };
}

function fallbackConfig(failFallback: boolean): AgentTeamConfig {
  const config = createDefaultConfig("fallback-fixture");
  config.profiles["primary-worker"] = {
    adapter: "fixture",
    model: "boom",
    reasoning: "medium",
    permission: "workspace-write",
    externalTools: "deny",
    timeoutSeconds: 60,
    args: [],
  };
  config.profiles["fallback-worker"] = {
    adapter: "fixture",
    model: failFallback ? "boom" : "ok",
    reasoning: "medium",
    permission: "workspace-write",
    externalTools: "deny",
    timeoutSeconds: 60,
    args: [],
  };
  config.roles.worker = {
    defaultProfile: "primary-worker",
    allowedProfiles: ["primary-worker", "fallback-worker"],
    fallbackProfiles: ["fallback-worker"],
  };
  return config;
}

function fakeStore(artifactsRoot: string) {
  return {
    artifactDirectory: (runId: string, ...parts: string[]) =>
      path.join(artifactsRoot, runId, "artifacts", ...parts),
    emit: () => {},
  };
}

function fixtureAdapter(models: string[]): AgentAdapter {
  return {
    name: "fixture",
    contract: {
      version: 1,
      transport: "local-process",
      permissions: ["read-only", "workspace-write"],
      externalTools: ["deny"],
      structuredOutput: true,
      usage: [],
    } as AgentAdapter["contract"],
    supportedReasoning: ["medium"],
    buildInvocation: (profile, request) => {
      models.push(profile.model);
      if (profile.model === "boom") {
        // A missing executable makes spawn fail with ENOENT.
        return {
          command: "agent-team-missing-executable",
          args: [],
          cwd: request.cwd,
          stdin: request.prompt,
          timeoutMs: 1_000,
        };
      }
      const script =
        "let raw = '';" +
        "process.stdin.on('data', (chunk) => { raw += chunk; });" +
        "process.stdin.on('end', () => {" +
        "process.stdout.write(JSON.stringify({ answer: 'from-fallback' }));" +
        "});";
      return {
        command: process.execPath,
        args: ["-e", script],
        cwd: request.cwd,
        stdin: request.prompt,
        timeoutMs: 1_000,
      };
    },
    parseResult: async (_invocation, processResult) => {
      try {
        return {
          text: processResult.stdout,
          structured: JSON.parse(processResult.stdout),
          process: processResult,
        };
      } catch {
        return { text: processResult.stdout, process: processResult };
      }
    },
    doctor: async () => [],
  };
}
