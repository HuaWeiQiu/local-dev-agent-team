import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentInvocationError } from "../src/adapters/invoke.js";
import { OneShotSession } from "../src/sessions/oneshot-session.js";
import type { OpenSessionOptions } from "../src/sessions/types.js";
import type { AgentProfile } from "../src/config/schema.js";

const invoke = vi.hoisted(() => ({ invokeAgent: vi.fn() }));
vi.mock("../src/adapters/invoke.js", async () => {
  const actual = await vi.importActual<typeof import("../src/adapters/invoke.js")>(
    "../src/adapters/invoke.js",
  );
  return { ...actual, invokeAgent: invoke.invokeAgent };
});

beforeEach(() => {
  invoke.invokeAgent.mockReset();
});

function session(extra: { artifactDirectory?: string; runId?: string } = {}): OneShotSession {
  const options = {
    adapterName: "kimi",
    profile: { adapter: "kimi", model: "m" } as AgentProfile,
    cwd: "/repo",
  } as OpenSessionOptions;
  return new OneShotSession(options, { get: vi.fn() } as never, extra);
}

function result(text = "完成", patch: Record<string, unknown> = {}) {
  return {
    text,
    structured: undefined,
    usage: undefined,
    process: { command: "kimi", args: [], cwd: "/repo", exitCode: 0, stdout: text, stderr: "", durationMs: 1 },
    ...patch,
  };
}

describe("OneShotSession.runTurn", () => {
  it("streams deltas and completes a turn", async () => {
    invoke.invokeAgent.mockImplementation(async (options: { onStdout: (chunk: string) => void }) => {
      options.onStdout("片段");
      return result("完成", { structured: { ok: true }, usage: { inputTokens: 1 } });
    });
    const s = session({ artifactDirectory: "/tmp/art", runId: "run-1" });
    const events: string[] = [];
    s.onEvent((event) => events.push(event.type));

    const turn = await s.runTurn({ prompt: "做一个功能" });
    expect(turn.status).toBe("completed");
    expect(turn.text).toBe("完成");
    expect(turn.structured).toEqual({ ok: true });
    expect(turn.usage).toEqual({ inputTokens: 1 });
    expect(events).toEqual(["turn-started", "text-delta", "message", "usage", "turn-completed"]);
    expect(turn.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("omits usage and structured when the adapter reported none", async () => {
    invoke.invokeAgent.mockResolvedValue(result("纯文本"));
    const turn = await session().runTurn({ prompt: "x" });
    expect(turn.structured).toBeUndefined();
    expect(turn.usage).toBeUndefined();
  });

  it("returns interrupted when the signal aborted", async () => {
    const controller = new AbortController();
    invoke.invokeAgent.mockImplementation(async () => {
      controller.abort();
      throw new Error("aborted");
    });
    const turn = await session().runTurn({ prompt: "x", signal: controller.signal });
    expect(turn).toMatchObject({ status: "interrupted", text: "" });
  });

  it("reports a provider failure with its text", async () => {
    invoke.invokeAgent.mockRejectedValue(
      new AgentInvocationError("provider failed", result("部分输出") as never),
    );
    const turn = await session().runTurn({ prompt: "x" });
    expect(turn.status).toBe("failed");
    expect(turn.text).toBe("部分输出");
    expect(turn.error).toContain("provider failed");
  });

  it("marks a timeout differently", async () => {
    invoke.invokeAgent.mockRejectedValue(
      new AgentInvocationError(
        "provider failed",
        result("", { process: { command: "kimi", args: [], cwd: "/repo", exitCode: 1, stdout: "", stderr: "", durationMs: 1, timedOut: true } }) as never,
      ),
    );
    const turn = await session().runTurn({ prompt: "x" });
    expect(turn.error).toContain("timed out:");
  });

  it("wraps a non-Error rejection", async () => {
    invoke.invokeAgent.mockRejectedValue("plain string");
    const turn = await session().runTurn({ prompt: "x" });
    expect(turn).toMatchObject({ status: "failed", text: "", error: "plain string" });
  });

  it("refuses a second turn while one is running", async () => {
    let release: (value: unknown) => void = () => undefined;
    invoke.invokeAgent.mockImplementation(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );
    const s = session();
    const first = s.runTurn({ prompt: "第一个" });
    await expect(s.runTurn({ prompt: "第二个" })).rejects.toThrow(/already running/);
    release(result("完成"));
    expect((await first).status).toBe("completed");
  });

  it("refuses a turn after close and on an aborted signal", async () => {
    const s = session();
    await s.close();
    await expect(s.runTurn({ prompt: "x" })).rejects.toThrow(/closed/);

    const controller = new AbortController();
    controller.abort();
    invoke.invokeAgent.mockRejectedValue(new Error("aborted before start"));
    const aborted = await session().runTurn({ prompt: "x", signal: controller.signal });
    expect(aborted.status).toBe("interrupted");
  });

  it("declares its unsupported capabilities", async () => {
    const s = session();
    await expect(s.steer()).rejects.toThrow(/steered/);
    await expect(s.interrupt()).rejects.toThrow(/interrupted/);
    await expect(s.answer()).rejects.toThrow(/ask questions/);
  });
});
