import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  AgentInvocationObservation,
  AgentInvocationObserver,
} from "../src/agents/service.js";
import { ProfiledAgentService } from "../src/agents/service.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { CodexActivityParser } from "../src/adapters/codex-events.js";
import { AgentInvocationError } from "../src/adapters/invoke.js";
import type { AgentAdapter } from "../src/adapters/types.js";
import { createDefaultConfig } from "../src/config/defaults.js";
import type { AgentTeamConfig } from "../src/config/schema.js";
import { RunBudgetExceededError } from "../src/observability/budget.js";
import {
  ProviderHealthRegistry,
  RoleProfileChainError,
  classificationForCode,
} from "../src/providers/failure.js";
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
    const failed = fixture.emitted.find((event) => event.type === "agent.profile.failed");
    expect(failed?.payload).toMatchObject({
      profile: "primary-worker",
      failure: { code: "MODEL_PROCESS_ERROR", infrastructure: true },
      nextProfile: "fallback-worker",
    });
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

    expect(error).toBeInstanceOf(RoleProfileChainError);
    expect((error as RoleProfileChainError).message).toContain(
      "All profiles failed for role 'worker'",
    );
    expect((error as RoleProfileChainError).message).toContain("primary-worker:");
    expect((error as RoleProfileChainError).message).toContain("fallback-worker:");
    expect((error as RoleProfileChainError).codes.length).toBe(2);
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
      new ProviderHealthRegistry(),
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

  it("skips a profile whose circuit is open and records the skip", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-circuit-"));
    const config = fallbackConfig(false);
    const models: string[] = [];
    const emitted: Array<{ runId: string; type: string; payload: unknown }> = [];
    const health = new ProviderHealthRegistry(() => 1_000);
    health.recordFailure(
      "primary-worker",
      "fixture",
      "boom",
      classificationForCode("MODEL_RATE_LIMITED"),
    );
    const service = new ProfiledAgentService(
      config,
      root,
      fakeStore(path.join(root, "artifacts"), emitted) as unknown as RunStateStore,
      {},
      undefined,
      undefined,
      new AdapterRegistry([fixtureAdapter(models)]),
      health,
    );

    const response = await service.runText({
      role: "worker",
      context: { case: "circuit-open" },
      runId: "run-circuit",
      artifactKey: "fallback/circuit",
    });

    expect(response.profileName).toBe("fallback-worker");
    expect(response.usedFallback).toBe(true);
    // The open circuit never reached an adapter.
    expect(models).toEqual(["ok"]);
    expect(emitted.find((event) => event.type === "agent.profile.skipped")?.payload).toMatchObject({
      role: "worker",
      profile: "primary-worker",
      adapter: "fixture",
      model: "boom",
      reason: expect.stringContaining("circuit open"),
      failure: { code: "MODEL_RATE_LIMITED" },
    });
    expect(emitted.some((event) => event.type === "agent.profile.failed")).toBe(false);
  });

  it("reports the failed invocation to the observer before falling back", async () => {
    const observations: AgentInvocationObservation[] = [];
    const observer: AgentInvocationObserver = {
      beforeInvocation: async () => `invocation-${observations.length + 1}`,
      afterInvocation: async (observation) => {
        observations.push(observation);
      },
    };
    const fixture = await createFixture({ observer, primaryModel: "crash" });

    const response = await fixture.service.runText({
      role: "worker",
      context: { case: "observed-fallback" },
      runId: "run-observed",
      artifactKey: "fallback/observed",
    });

    expect(response.profileName).toBe("fallback-worker");
    expect(observations.map((observation) => observation.profile)).toEqual([
      "primary-worker",
      "fallback-worker",
    ]);
    const failed = observations[0]!;
    expect(failed.error).toBeInstanceOf(AgentInvocationError);
    expect(failed.result).toBeDefined();
    expect(observations[1]!.result).toMatchObject({ text: expect.any(String) });
    expect(observations[1]!.error).toBeUndefined();
  });

  it("parses fenced JSON when the adapter returns text only", async () => {
    const { service } = await textOnlyFixture('```json\n{"answer":"fenced"}\n```');

    const response = await service.runStructured({
      role: "worker",
      context: { case: "fenced" },
      runId: "run-fenced",
      artifactKey: "fallback/fenced",
      schema: answerSchema,
      jsonSchema: answerJsonSchema,
    });

    expect(response.value).toEqual({ answer: "fenced" });
  });

  it("rejects text that carries no JSON at all", async () => {
    const { service } = await textOnlyFixture("plain prose, no JSON here");

    await expect(
      service.runStructured({
        role: "worker",
        context: { case: "unparsable" },
        runId: "run-unparsable",
        artifactKey: "fallback/unparsable",
        schema: answerSchema,
        jsonSchema: answerJsonSchema,
      }),
    ).rejects.toThrow("Agent output was not valid JSON");
  });
});

async function textOnlyFixture(text: string) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-text-"));
  const config = fallbackConfig(false);
  config.profiles["primary-worker"]!.model = "ok";
  const models: string[] = [];
  const emitted: Array<{ runId: string; type: string; payload: unknown }> = [];
  const adapter = fixtureAdapter(models);
  const service = new ProfiledAgentService(
    config,
    root,
    fakeStore(path.join(root, "artifacts"), emitted) as unknown as RunStateStore,
    {},
    undefined,
    undefined,
    new AdapterRegistry([
      {
        ...adapter,
        parseResult: async (_invocation, processResult) => ({ text, process: processResult }),
      },
    ]),
    new ProviderHealthRegistry(),
  );
  return { service, models };
}

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
    primaryModel?: string;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-fallback-"));
  const config = fallbackConfig(options.failFallback === true);
  if (options.primaryModel) config.profiles["primary-worker"]!.model = options.primaryModel;
  const models: string[] = [];
  const adapter = fixtureAdapter(models);
  const emitted: Array<{ runId: string; type: string; payload: unknown }> = [];
  const store = fakeStore(path.join(root, "artifacts"), emitted);
  const service = new ProfiledAgentService(
    config,
    root,
    store as unknown as RunStateStore,
    {},
    options.signal,
    options.observer,
    new AdapterRegistry([adapter]),
    new ProviderHealthRegistry(),
  );
  return { service, models, emitted };
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

function fakeStore(
  artifactsRoot: string,
  emitted: Array<{ runId: string; type: string; payload: unknown }> = [],
) {
  return {
    artifactDirectory: (runId: string, ...parts: string[]) =>
      path.join(artifactsRoot, runId, "artifacts", ...parts),
    emit: (runId: string, type: string, payload: unknown) => {
      emitted.push({ runId, type, payload });
    },
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
      if (profile.model === "crash") {
        return {
          command: process.execPath,
          args: ["-e", "process.exit(1)"],
          cwd: request.cwd,
          stdin: request.prompt,
          timeoutMs: 1_000,
        };
      }
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
