import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentProfile } from "../src/config/schema.js";
import { ProviderFailureError } from "../src/providers/failure.js";
import {
  SessionFactory,
  runTurnOrThrow,
  type AgentSession,
  type SessionEvent,
} from "../src/sessions/index.js";

let directory: string;
let fakeCodex: string;
let fakeClaude: string;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "sessions-test-"));
  fakeCodex = path.join(directory, "fake-codex");
  fakeClaude = path.join(directory, "fake-claude");
  await copyFile(path.resolve(import.meta.dirname, "support/fake-codex.mjs"), fakeCodex);
  await copyFile(path.resolve(import.meta.dirname, "support/fake-claude.mjs"), fakeClaude);
  await chmod(fakeCodex, 0o755);
  await chmod(fakeClaude, 0o755);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function profile(adapter: string, executable: string, overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    adapter,
    executable,
    model: "inherit",
    reasoning: "low",
    permission: "workspace-write",
    externalTools: "deny",
    timeoutSeconds: 60,
    args: [],
    ...overrides,
  };
}

function collect(session: AgentSession): SessionEvent[] {
  const events: SessionEvent[] = [];
  session.onEvent((event) => events.push(event));
  return events;
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("SessionFactory", () => {
  it("selects live sessions when the CLI version is new enough", async () => {
    const factory = new SessionFactory();
    const codex = await factory.plan("codex", profile("codex", fakeCodex), directory);
    expect(codex).toMatchObject({
      kind: "codex-app-server",
      capabilities: { steer: true, interrupt: true, askUser: true, resume: false },
    });
    const claude = await factory.plan("claude", profile("claude", fakeClaude, { externalTools: "inherit" }), directory);
    expect(claude).toMatchObject({ kind: "claude-stream", capabilities: { resume: true } });
  });

  it("falls back to one-shot for old versions, extra args, other adapters and when disabled", async () => {
    const factory = new SessionFactory({ versionProbe: async () => "0.100.0" });
    expect((await factory.plan("codex", profile("codex", fakeCodex), directory)).kind).toBe("one-shot");
    expect((await factory.plan("codex", profile("codex", fakeCodex), directory)).reason).toMatch(/older than/);

    const live = new SessionFactory();
    const withArgs = await live.plan("codex", profile("codex", fakeCodex, { args: ["--foo"] }), directory);
    expect(withArgs).toMatchObject({ kind: "one-shot", capabilities: { steer: false, interrupt: false } });
    expect((await live.plan("grok", profile("grok", "grok"), directory)).kind).toBe("one-shot");
    expect((await new SessionFactory({ mode: "off" }).plan("codex", profile("codex", fakeCodex), directory)).kind).toBe(
      "one-shot",
    );
  });

  it("treats an unreadable version as one-shot", async () => {
    const factory = new SessionFactory({ versionProbe: async () => undefined });
    expect((await factory.plan("claude", profile("claude", fakeClaude), directory)).reason).toMatch(/version/);
  });
});

describe("Codex app-server session", () => {
  const open = (overrides: Partial<AgentProfile> = {}, extra: Record<string, unknown> = {}) =>
    new SessionFactory().open({
      adapterName: "codex",
      profile: profile("codex", fakeCodex, overrides),
      cwd: directory,
      ...extra,
    });

  it("runs a turn, streams events and reports per-turn usage deltas", async () => {
    const session = await open();
    const events = collect(session);
    const first = await session.runTurn({ prompt: "hello tool" });
    expect(first).toMatchObject({ status: "completed", text: "echo:hello tool" });
    expect(first.usage).toEqual({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 });
    expect(session.nativeSessionId).toBe("thr-1");
    expect(events.filter((event) => event.type === "tool").map((event) => event.type === "tool" && event.status)).toEqual([
      "started",
      "completed",
    ]);

    const second = await session.runTurn({ prompt: "again" });
    expect(second.usage).toEqual({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 });
    await session.close();
  });

  it("parses structured output when a schema is supplied", async () => {
    const session = await open();
    const result = await session.runTurn({ prompt: "json", outputSchema: { type: "object" } });
    expect(result.structured).toEqual({ ok: true });
    await session.close();
  });

  it("steers a running turn", async () => {
    const session = await open();
    const events = collect(session);
    const turn = session.runTurn({ prompt: "slow" });
    await until(() => events.some((event) => event.type === "text-delta"));
    await session.steer("use approach B");
    expect(await turn).toMatchObject({ status: "completed", text: "steered:use approach B" });
    await expect(session.steer("late")).rejects.toMatchObject({ code: "not-running" });
    await session.close();
  });

  it("interrupts a running turn and keeps the session usable", async () => {
    const session = await open();
    const events = collect(session);
    const turn = session.runTurn({ prompt: "slow" });
    await until(() => events.some((event) => event.type === "text-delta"));
    await session.interrupt();
    expect(await turn).toMatchObject({ status: "interrupted" });
    expect(await session.runTurn({ prompt: "next" })).toMatchObject({ status: "completed" });
    await session.close();
  });

  it("aborts through the signal by interrupting the turn", async () => {
    const session = await open();
    const controller = new AbortController();
    const turn = session.runTurn({ prompt: "slow", signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    expect(await turn).toMatchObject({ status: "interrupted" });
    await session.close();
  });

  it("surfaces model questions and resumes the turn with the answer", async () => {
    const session = await open();
    const events = collect(session);
    const turn = session.runTurn({ prompt: "ask" });
    await until(() => events.some((event) => event.type === "question"));
    const question = events.find((event) => event.type === "question");
    expect(question).toMatchObject({ prompt: "Which option?", options: ["A", "B"] });
    await session.answer((question as { questionId: string }).questionId, "B");
    expect(await turn).toMatchObject({ status: "completed", text: "answer:B" });
    await session.close();
  });

  it("never grants command approvals automatically", async () => {
    const session = await open();
    const events = collect(session);
    expect(await session.runTurn({ prompt: "approve" })).toMatchObject({ text: "approval-handled" });
    expect(events.some((event) => event.type === "notice" && /declined/.test(event.message))).toBe(true);
    await session.close();
  });

  it("maps a failed turn onto the provider failure classification", async () => {
    const session = await open();
    const failure = await runTurnOrThrow(session, { prompt: "fail" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderFailureError);
    expect((failure as ProviderFailureError).classification.signals.join(" ")).toBeTruthy();
    await session.close();
  });

  it("rejects the turn when the process dies", async () => {
    const session = await open();
    await expect(session.runTurn({ prompt: "die" })).rejects.toMatchObject({ code: "process-exit" });
    await expect(session.runTurn({ prompt: "again" })).rejects.toMatchObject({ code: "process-exit" });
    await session.close();
  });

  it("isolates user configuration when external tools are denied and cleans up", async () => {
    const log = path.join(directory, "codex-deny.log");
    const session = await open({ externalTools: "deny" }, { env: { ...process.env, FAKE_LOG: log } });
    await session.runTurn({ prompt: "hi" });
    const entry = JSON.parse((await readFile(log, "utf8")).trim().split("\n")[0]!);
    expect(entry.argv).toContain("project_root_markers=[]");
    expect(entry.codexHome).toMatch(/agent-team-codex-/);
    expect(existsSync(entry.codexHome)).toBe(true);
    await session.close();
    expect(existsSync(entry.codexHome)).toBe(false);
  });

  it("keeps the real home and persists the thread when external tools are inherited", async () => {
    const log = path.join(directory, "codex-inherit.log");
    const session = await open({ externalTools: "inherit" }, { env: { ...process.env, FAKE_LOG: log, CODEX_HOME: "/tmp/real-home" } });
    expect(session.capabilities.resume).toBe(true);
    await session.runTurn({ prompt: "hi" });
    const entry = JSON.parse((await readFile(log, "utf8")).trim().split("\n")[0]!);
    expect(entry.codexHome).toBe("/tmp/real-home");
    await session.close();
  });

  it("resumes an existing thread", async () => {
    const session = await open({ externalTools: "inherit" }, { resumeSessionId: "thr-old" });
    await session.runTurn({ prompt: "hi" });
    expect(session.nativeSessionId).toBe("thr-old");
    await session.close();
  });
});

describe("Claude stream session", () => {
  const open = (overrides: Partial<AgentProfile> = {}, extra: Record<string, unknown> = {}) =>
    new SessionFactory().open({
      adapterName: "claude",
      profile: profile("claude", fakeClaude, overrides),
      cwd: directory,
      ...extra,
    });

  it("runs several turns in one conversation and accumulates usage", async () => {
    const log = path.join(directory, "claude.log");
    const session = await open({}, { env: { ...process.env, FAKE_LOG: log } });
    const events = collect(session);
    const first = await session.runTurn({ prompt: "hello tool" });
    expect(first).toMatchObject({ status: "completed", text: "echo:hello tool" });
    expect(first.usage).toEqual({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reportedCostUsd: 0.01 });
    expect(session.nativeSessionId).toBe("sess-1");
    expect(events.some((event) => event.type === "tool" && event.name === "Read")).toBe(true);
    expect(await session.runTurn({ prompt: "second" })).toMatchObject({ text: "echo:second" });
    const argv = JSON.parse((await readFile(log, "utf8")).trim()).argv as string[];
    expect(argv).toContain("--no-session-persistence");
    expect(argv).toContain("--strict-mcp-config");
    await session.close();
  });

  it("restricts read-only roles to read tools", async () => {
    const log = path.join(directory, "claude-ro.log");
    const session = await open({ permission: "read-only" }, { env: { ...process.env, FAKE_LOG: log } });
    await session.runTurn({ prompt: "hi" });
    const argv = JSON.parse((await readFile(log, "utf8")).trim()).argv as string[];
    expect(argv).toContain("plan");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
    await session.close();
  });

  it("redirects a running turn with operator guidance in the same conversation", async () => {
    const session = await open();
    const events = collect(session);
    const turn = session.runTurn({ prompt: "slow" });
    await until(() => events.some((event) => event.type === "text-delta"));
    await session.steer("prefer approach B");
    expect(await turn).toMatchObject({ status: "completed", text: "redirected:prefer approach B" });
    await session.close();
  });

  it("interrupts a running turn", async () => {
    const session = await open();
    const events = collect(session);
    const turn = session.runTurn({ prompt: "slow" });
    await until(() => events.some((event) => event.type === "text-delta"));
    await session.interrupt();
    expect(await turn).toMatchObject({ status: "interrupted" });
    await session.close();
  });

  it("answers AskUserQuestion through the operator", async () => {
    const session = await open();
    const events = collect(session);
    const turn = session.runTurn({ prompt: "ask" });
    await until(() => events.some((event) => event.type === "question"));
    const question = events.find((event) => event.type === "question") as { questionId: string; options: string[] };
    expect(question.options).toEqual(["A", "B"]);
    await session.answer(question.questionId, "A");
    expect(await turn).toMatchObject({ text: 'answer:{"Which option?":"A"}' });
    await session.close();
  });

  it("denies tools the permission mode would not allow", async () => {
    const session = await open();
    expect(await session.runTurn({ prompt: "bash" })).toMatchObject({ text: "bash:deny" });
    await session.close();
  });

  it("falls back to prompt-embedded schemas and parses the JSON reply", async () => {
    const session = await open();
    const result = await session.runTurn({ prompt: "json", outputSchema: { type: "object" } });
    expect(result.structured).toEqual({ ok: true });
    await session.close();
  });

  it("reports provider failures and process death", async () => {
    const session = await open();
    await expect(runTurnOrThrow(session, { prompt: "fail" })).rejects.toBeInstanceOf(ProviderFailureError);
    await session.close();
    const dying = await open();
    await expect(dying.runTurn({ prompt: "die" })).rejects.toMatchObject({ code: "process-exit" });
    await dying.close();
  });
});

describe("one-shot fallback session", () => {
  it("has no live capabilities and rejects mid-turn control", async () => {
    const factory = new SessionFactory({ mode: "off" });
    const session = await factory.open({
      adapterName: "codex",
      profile: profile("codex", fakeCodex),
      cwd: directory,
    });
    expect(session.kind).toBe("one-shot");
    expect(session.capabilities).toEqual({ steer: false, interrupt: false, askUser: false, resume: false });
    await expect(session.steer("x")).rejects.toMatchObject({ code: "unsupported" });
    await expect(session.interrupt()).rejects.toMatchObject({ code: "unsupported" });
    await session.close();
  });

  it("returns a failed turn instead of throwing for a broken executable", async () => {
    const factory = new SessionFactory({ mode: "off" });
    const session = await factory.open({
      adapterName: "codex",
      profile: profile("codex", path.join(directory, "missing-cli")),
      cwd: directory,
    });
    const result = await session.runTurn({ prompt: "hi" });
    expect(result.status).toBe("failed");
    expect(result.error).toBeTruthy();
  });
});
