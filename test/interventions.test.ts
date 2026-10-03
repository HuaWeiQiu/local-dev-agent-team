import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProfiledAgentService } from "../src/agents/service.js";
import { createDefaultConfig } from "../src/config/defaults.js";
import {
  InterventionError,
  LiveAgentRegistry,
  OperatorInterruptError,
} from "../src/interventions/registry.js";
import { ProviderHealthRegistry } from "../src/providers/failure.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import {
  NO_CAPABILITIES,
  SessionFactory,
  type AgentSession,
  type SessionEvent,
  type SessionEventListener,
} from "../src/sessions/index.js";
import type { RunStateStore } from "../src/state/store.js";

let directory: string;
let fakeCodex: string;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "interventions-test-"));
  fakeCodex = path.join(directory, "fake-codex");
  await copyFile(path.resolve(import.meta.dirname, "support/fake-codex.mjs"), fakeCodex);
  await chmod(fakeCodex, 0o755);
  await writeFile(path.join(directory, "worker.md"), "You are a test worker.\n");
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

interface Emitted {
  runId: string;
  type: string;
  payload: Record<string, unknown>;
}

function fixture(workflow?: { stallSeconds: number; maxStallRecoveries: number }) {
  const emitted: Emitted[] = [];
  const emit = (runId: string, type: string, payload: unknown) => {
    emitted.push({ runId, type, payload: payload as Record<string, unknown> });
  };
  const config = createDefaultConfig("interventions");
  config.profiles["fake-codex"] = {
    adapter: "codex",
    executable: fakeCodex,
    model: "inherit",
    reasoning: "low",
    permission: "workspace-write",
    externalTools: "deny",
    timeoutSeconds: 60,
    args: [],
  };
  if (workflow) {
    config.workflow = {
      engine: "v2",
      template: "auto",
      sessions: "auto",
      flakyReruns: 1,
      ...workflow,
    };
  }
  config.roles.worker = {
    defaultProfile: "fake-codex",
    allowedProfiles: ["fake-codex"],
    fallbackProfiles: [],
    promptFile: "worker.md",
  };
  const registry = new LiveAgentRegistry(emit);
  const store = {
    artifactDirectory: (runId: string, ...parts: string[]) => path.join(directory, "artifacts", runId, ...parts),
    emit,
  };
  const service = new ProfiledAgentService(
    config,
    directory,
    store as unknown as RunStateStore,
    {},
    undefined,
    undefined,
    new AdapterRegistry(),
    new ProviderHealthRegistry(),
    { factory: new SessionFactory(), registry },
  );
  const run = (runId: string, scenario: string) =>
    service.runText({
      role: "worker",
      context: { scenario, task: { id: "T1" } },
      runId,
      artifactKey: `${runId}-worker`,
    });
  return { emitted, registry, service, run };
}

async function until<T>(read: () => T | undefined | false, timeoutMs = 5_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function retry(action: () => Promise<void>, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await action();
      return;
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

describe("live agent interventions", () => {
  it("lists the running agent and steers it mid-turn", async () => {
    const { registry, run, emitted } = fixture();
    const pending = run("steer-run", "slow");
    const agent = await until(() => registry.list("steer-run")[0]);
    expect(agent).toMatchObject({
      role: "worker",
      taskId: "T1",
      kind: "codex-app-server",
      capabilities: { steer: true, interrupt: true },
    });

    await retry(() => registry.steer("steer-run", agent.id, "use approach B", "tech-lead"));
    const result = await pending;
    expect(result.text).toBe("steered:use approach B");
    expect(registry.list("steer-run")).toEqual([]);
    const types = emitted.map((event) => event.type);
    expect(types).toContain("agent.session.opened");
    expect(types).toContain("agent.session.closed");
    expect(emitted.find((event) => event.type === "agent.steered")?.payload).toMatchObject({
      actor: "tech-lead",
      text: "use approach B",
      taskId: "T1",
    });
  });

  it("redirects an interrupted agent with the operator's note", async () => {
    const { registry, run, emitted } = fixture();
    const pending = run("redirect-run", "slow");
    const agent = await until(() => registry.list("redirect-run")[0]);
    await retry(() => registry.interrupt("redirect-run", agent.id, { actor: "lead", note: "skip the refactor" }));
    const result = await pending;
    expect(result.text).toContain("skip the refactor");
    expect(emitted.find((event) => event.type === "agent.interrupted")?.payload).toMatchObject({
      redirected: true,
      note: "skip the refactor",
    });
  });

  it("ends the attempt on a plain interrupt without tripping provider health", async () => {
    const { registry, run, emitted } = fixture();
    const pending = run("stop-run", "slow");
    const settled = pending.catch((error: unknown) => error);
    const agent = await until(() => registry.list("stop-run")[0]);
    await retry(() => registry.interrupt("stop-run", agent.id, { actor: "lead" }));
    const error = await settled;
    expect(error).toBeInstanceOf(OperatorInterruptError);
    expect((error as Error).message).toContain("lead");
    expect(emitted.some((event) => event.type === "agent.profile.failed")).toBe(false);
  });

  it("surfaces an agent question and delivers the answer", async () => {
    const { registry, run, emitted } = fixture();
    const pending = run("ask-run", "ask");
    const agent = await until(() => {
      const [first] = registry.list("ask-run");
      return first && first.questions.length > 0 ? first : undefined;
    });
    expect(agent.status).toBe("awaiting-answer");
    const question = agent.questions[0]!;
    expect(question.prompt).toContain("Which option?");

    await registry.answer("ask-run", agent.id, question.questionId, "B", "lead");
    expect((await pending).text).toBe("answer:B");
    expect(emitted.find((event) => event.type === "agent.question")?.payload).toMatchObject({
      prompt: expect.stringContaining("Which option?"),
    });
    expect(emitted.find((event) => event.type === "agent.answered")?.payload).toMatchObject({
      actor: "lead",
      answer: "B",
    });
  });

  it("rejects interventions for unknown agents and other runs", async () => {
    const { registry, run } = fixture();
    await expect(registry.steer("x", "missing", "hi", "a")).rejects.toMatchObject({ code: "not-found" });
    const pending = run("scoped-run", "slow");
    const agent = await until(() => registry.list("scoped-run")[0]);
    await expect(registry.steer("other-run", agent.id, "hi", "a")).rejects.toBeInstanceOf(InterventionError);
    await retry(() => registry.interrupt("scoped-run", agent.id, { actor: "a", note: "finish" }));
    await pending;
  });
});

class StubSession implements AgentSession {
  readonly kind = "one-shot" as const;
  readonly nativeSessionId = undefined;
  private listeners = new Set<SessionEventListener>();
  answered: string[] = [];

  constructor(readonly capabilities = NO_CAPABILITIES) {}
  onEvent(listener: SessionEventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: SessionEvent) {
    for (const listener of this.listeners) listener(event);
  }
  async runTurn(): Promise<never> {
    throw new Error("not used");
  }
  async steer() {}
  async interrupt() {}
  async answer(_id: string, answer: string) {
    this.answered.push(answer);
  }
  async close() {}
}

describe("LiveAgentRegistry", () => {
  const attach = (session: StubSession) => {
    const emitted: Emitted[] = [];
    const registry = new LiveAgentRegistry((runId, type, payload) =>
      emitted.push({ runId, type, payload: payload as Record<string, unknown> }),
    );
    const handle = registry.attach(
      { runId: "r1", role: "worker", artifactKey: "k", profile: "p", adapter: "grok", model: "m" },
      session,
    );
    return { registry, handle, emitted };
  };

  it("refuses steer and interrupt when the session lacks the capability", async () => {
    const { registry, handle } = attach(new StubSession());
    await expect(registry.steer("r1", handle.id, "x", "a")).rejects.toMatchObject({ code: "unsupported" });
    await expect(registry.interrupt("r1", handle.id, { actor: "a" })).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("delivers a secret answer but keeps it out of the ledger", async () => {
    const session = new StubSession({ steer: false, interrupt: false, askUser: true, resume: false });
    const { registry, handle, emitted } = attach(session);
    session.emit({ type: "question", turnId: "t", questionId: "q", prompt: "Token?", secret: true });
    await registry.answer("r1", handle.id, "q", "s3cret", "lead");
    expect(session.answered).toEqual(["s3cret"]);
    const answered = emitted.find((event) => event.type === "agent.answered")!;
    expect(answered.payload).toMatchObject({ redacted: true });
    expect(JSON.stringify(emitted)).not.toContain("s3cret");
  });

  it("forgets an agent after it detaches", () => {
    const { registry, handle } = attach(new StubSession());
    expect(registry.list("r1")).toHaveLength(1);
    handle.detach();
    expect(registry.list("r1")).toHaveLength(0);
  });
});

describe("stall watchdog", () => {
  it("interrupts a silent agent and continues the same task", async () => {
    const { run, emitted } = fixture({ stallSeconds: 0.3, maxStallRecoveries: 2 });
    const result = await run("stall-run", "slow");
    expect(result.text).toContain("stopped producing output");
    const stalled = emitted.filter((event) => event.type === "agent.stalled");
    expect(stalled).toHaveLength(1);
    expect(stalled[0]?.payload).toMatchObject({ role: "worker", taskId: "T1", recovery: 1, maxRecoveries: 2 });
  });

  it("fails as a timeout once recoveries are exhausted", async () => {
    const { run, emitted } = fixture({ stallSeconds: 0.2, maxStallRecoveries: 1 });
    await expect(run("stall-forever-run", "hangforever")).rejects.toThrow(/stalled/i);
    expect(emitted.filter((event) => event.type === "agent.stalled")).toHaveLength(2);
  });

  it("stays quiet when the watchdog is disabled", async () => {
    const { run, registry } = fixture({ stallSeconds: 0, maxStallRecoveries: 2 });
    const pending = run("no-stall-run", "slow");
    const agent = await until(() => registry.list("no-stall-run")[0]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(registry.list("no-stall-run")).toHaveLength(1);
    await retry(() => registry.steer("no-stall-run", agent.id, "go", "lead"));
    await expect(pending).resolves.toMatchObject({ text: "steered:go" });
  });
});
