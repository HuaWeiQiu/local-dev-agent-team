import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamProcess, StreamProcessRequest } from "../src/process/stream.js";
import type { AgentProfile } from "../src/config/schema.js";

const { spawnCalls, resolveExit, writes } = vi.hoisted(() => ({
  spawnCalls: [] as StreamProcessRequest[],
  resolveExit: [] as Array<(value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void>,
  writes: [] as string[],
}));

vi.mock("../src/process/stream.js", () => ({
  spawnStreamProcess: (request: StreamProcessRequest): StreamProcess => {
    spawnCalls.push(request);
    let exitNow: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void =
      () => undefined;
    const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        exitNow = resolve;
      },
    );
    resolveExit.push(exitNow);
    return {
      pid: 4242,
      write: (line: string) => {
        writes.push(line);
        return true;
      },
      closeStdin: () => undefined,
      terminate: () => undefined,
      exited,
      stderrTail: () => "stderr tail",
    };
  },
}));

const { ClaudeStreamSession } = await import("../src/sessions/claude-session.js");

const profile: AgentProfile = {
  adapter: "claude",
  model: "inherit",
  reasoning: "high",
  permission: "workspace-write",
  externalTools: "inherit",
  timeoutSeconds: 60,
  args: [],
};

function session(overrides: { sessionSchema?: Record<string, unknown> } = {}) {
  return new ClaudeStreamSession(
    { root: "/tmp/repo", cwd: "/tmp/repo", profile, ...overrides } as never,
    "claude",
  );
}

beforeEach(() => {
  spawnCalls.length = 0;
  resolveExit.length = 0;
  writes.length = 0;
});

function exitNow(value: { exitCode: number | null; signal: NodeJS.Signals | null }): void {
  const resolve = resolveExit[resolveExit.length - 1];
  if (!resolve) throw new Error("no spawned process to exit");
  resolve(value);
}

function lastSent(): { type: string; message?: { content: Array<{ text: string }> } } {
  return JSON.parse(writes[writes.length - 1]!) as {
    type: string;
    message?: { content: Array<{ text: string }> };
  };
}

describe("ClaudeStreamSession.runTurn", () => {
  it("refuses a turn on a closed session", async () => {
    const closed = session();
    await closed.close();

    await expect(closed.runTurn({ prompt: "hi" })).rejects.toMatchObject({ code: "closed" });
  });

  it("refuses a second turn while one is still running", async () => {
    const live = session();
    const first = live.runTurn({ prompt: "first" });

    await expect(live.runTurn({ prompt: "second" })).rejects.toMatchObject({ code: "protocol" });
    exitNow({ exitCode: 0, signal: null });
    await expect(first).rejects.toMatchObject({ code: "process-exit" });
  });

  it("emits turn-started and sends the prompt as a user message", async () => {
    const live = session();
    const events: string[] = [];
    live.onEvent((event) => events.push(event.type));
    const pending = live.runTurn({ prompt: "do the work" });

    expect(events).toContain("turn-started");
    expect(lastSent()).toMatchObject({ type: "user" });

    exitNow({ exitCode: 0, signal: null });
    await expect(pending).rejects.toMatchObject({ code: "process-exit" });
  });

  it("leaves a matching schema prompt untouched", async () => {
    const schema = { type: "object" };
    const live = session({ sessionSchema: schema });
    const pending = live.runTurn({ prompt: "plain prompt", outputSchema: schema });

    expect(lastSent().message?.content[0]?.text).toBe("plain prompt");

    exitNow({ exitCode: 0, signal: null });
    await expect(pending).rejects.toMatchObject({ code: "process-exit" });
  });

  it("appends the schema instruction when the turn schema differs from the session one", async () => {
    const live = session({ sessionSchema: { type: "object" } });
    const pending = live.runTurn({
      prompt: "structured",
      outputSchema: { type: "object", properties: { answer: { type: "string" } } },
    });

    expect(lastSent().message?.content[0]?.text).toContain("structured");
    expect(lastSent().message?.content[0]?.text).toContain("answer");

    exitNow({ exitCode: 0, signal: null });
    await expect(pending).rejects.toMatchObject({ code: "process-exit" });
  });

  it("refuses to start when the caller's signal is already aborted", async () => {
    const live = session();
    const controller = new AbortController();
    controller.abort();

    await expect(
      live.runTurn({ prompt: "late", signal: controller.signal }),
    ).rejects.toThrow();
    expect(spawnCalls).toHaveLength(0);
  });

  it("rejects the in-flight turn when the child process dies", async () => {
    const live = session();
    const pending = live.runTurn({ prompt: "work" });

    exitNow({ exitCode: 1, signal: null });
    await expect(pending).rejects.toMatchObject({ code: "process-exit" });
    await expect(live.runTurn({ prompt: "again" })).rejects.toMatchObject({ code: "process-exit" });
  });

  it("interrupts the turn when the caller aborts mid-turn", async () => {
    const live = session();
    const controller = new AbortController();
    const pending = live.runTurn({ prompt: "work", signal: controller.signal });

    controller.abort();

    const control = JSON.parse(writes[writes.length - 1]!) as {
      type: string;
      request?: { subtype?: string };
    };
    expect(control.type).toBe("control_request");
    expect(control.request?.subtype).toBe("interrupt");

    exitNow({ exitCode: 0, signal: null });
    await expect(pending).rejects.toMatchObject({ code: "process-exit" });
  });

  it("times a turn out through the same interrupt path", async () => {
    vi.useFakeTimers();
    try {
      const live = session();
      const pending = live.runTurn({ prompt: "slow", timeoutMs: 1_000 });
      const settled = pending.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(1_000);
      const control = JSON.parse(writes[writes.length - 1]!) as {
        type: string;
        request?: { subtype?: string };
      };
      expect(control.request?.subtype).toBe("interrupt");

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(settled).resolves.toMatchObject({ status: "failed" });
    } finally {
      vi.useRealTimers();
    }
  });
});
