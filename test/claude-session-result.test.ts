import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamProcess, StreamProcessRequest } from "../src/process/stream.js";
import type { AgentProfile } from "../src/config/schema.js";

const { spawnCalls, resolveExit, deliver, writes } = vi.hoisted(() => ({
  spawnCalls: [] as StreamProcessRequest[],
  resolveExit: [] as Array<
    (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
  >,
  deliver: [] as Array<(line: string) => void>,
  writes: [] as string[],
}));

vi.mock("../src/process/stream.js", () => ({
  spawnStreamProcess: (request: StreamProcessRequest): StreamProcess => {
    spawnCalls.push(request);
    deliver.push(request.onLine);
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
      stderrTail: () => "",
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

function session() {
  return new ClaudeStreamSession(
    { adapterName: "claude", root: "/tmp/repo", cwd: "/tmp/repo", profile } as never,
    "claude",
  );
}

async function openTurn(input: { outputSchema?: Record<string, unknown> } = {}) {
  const built = session();
  const events: Array<Record<string, unknown>> = [];
  built.onEvent((event) => events.push(event as unknown as Record<string, unknown>));
  const pending = built.runTurn({ prompt: "go", ...input } as never);
  await Promise.resolve();
  const line = deliver[deliver.length - 1]!;
  return {
    built,
    events,
    line,
    settled: () => pending,
    resultLine: (patch: Record<string, unknown> = {}) =>
      line(JSON.stringify({ type: "result", subtype: "success", ...patch })),
  };
}

beforeEach(() => {
  spawnCalls.length = 0;
  resolveExit.length = 0;
  deliver.length = 0;
  writes.length = 0;
});

describe("turn status", () => {
  it.each([
    ["a clean result completes the turn", {}, "completed"],
    ["an errored result fails the turn", { isError: true }, "failed"],
  ] as const)("%s", async (_name, shape, expected) => {
    const opened = await openTurn();
    opened.resultLine({ is_error: shape.isError === true });

    await expect(opened.settled()).resolves.toMatchObject({ status: expected });
  });

  it("reports an operator interrupt as interrupted", async () => {
    const opened = await openTurn();
    await opened.built.interrupt();
    opened.resultLine({});

    await expect(opened.settled()).resolves.toMatchObject({ status: "interrupted" });
  });

  it("keeps the forced status when a result arrives after a timeout", async () => {
    vi.useFakeTimers();
    try {
      const built = session();
      const pending = built.runTurn({ prompt: "go", timeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(0);
      const line = deliver[deliver.length - 1]!;
      await vi.advanceTimersByTimeAsync(1_000);
      // The CLI answered after the deadline: the forced status must still win.
      line(JSON.stringify({ type: "result", subtype: "success", result: "late answer" }));

      await expect(pending).resolves.toMatchObject({
        status: "failed",
        error: expect.stringContaining("turn exceeded 1000ms"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the streamed text when the result carries none", async () => {
    const opened = await openTurn();
    opened.line(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "streamed" } } }));
    opened.resultLine();

    await expect(opened.settled()).resolves.toMatchObject({ text: "streamed" });
  });

  it("prefers the result text over the streamed text", async () => {
    const opened = await openTurn();
    opened.line(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "streamed" } } }));
    opened.resultLine({ result: "final answer" });

    await expect(opened.settled()).resolves.toMatchObject({ text: "final answer" });
  });

  it("records the native session id from the result", async () => {
    const opened = await openTurn();
    opened.resultLine({ session_id: "native-7" });
    await opened.settled();

    expect(opened.built.nativeSessionId).toBe("native-7");
  });

  it("broadcasts merged usage", async () => {
    const opened = await openTurn();
    opened.resultLine({ usage: { input_tokens: 3, output_tokens: 4 } });

    const usage = opened.events.find((event) => event.type === "usage");
    expect(usage).toBeDefined();
    await opened.settled();
  });

  it("reports a failed turn with the error text", async () => {
    const opened = await openTurn();
    opened.resultLine({ is_error: true, result: "boom" });

    await expect(opened.settled()).resolves.toMatchObject({
      status: "failed",
      error: JSON.stringify({ subtype: "success", message: "boom" }),
    });
  });
});

describe("operator redirect", () => {
  it("announces, sends the guidance, and settles only on the next result", async () => {
    const opened = await openTurn();
    await opened.built.steer("try the other approach");

    opened.resultLine({ result: "interrupted by operator" });

    // Order matters for the consumer: notice, then the guidance as a user turn.
    expect(opened.events.map((event) => event.type)).toEqual(["turn-started", "notice"]);
    expect(opened.events[1]).toMatchObject({ level: "info", message: "turn redirected by the operator" });
    const sent = JSON.parse(writes.at(-1)!) as { type: string; message: { content: Array<{ text: string }> } };
    expect(sent.type).toBe("user");
    expect(sent.message.content[0]?.text).toContain("try the other approach");

    opened.resultLine({ result: "done after redirect" });

    expect(opened.events.map((event) => event.type)).toEqual([
      "turn-started",
      "notice",
      "turn-completed",
    ]);
    await expect(opened.settled()).resolves.toMatchObject({ status: "completed", text: "done after redirect" });
  });

  it("does not redirect without a guidance string", async () => {
    const opened = await openTurn();
    await opened.built.interrupt();
    opened.resultLine({});

    await expect(opened.settled()).resolves.toMatchObject({ status: "interrupted" });
  });
});

describe("structured output parsing", () => {
  it("parses a bare JSON answer", async () => {
    const opened = await openTurn({ outputSchema: { type: "object" } });
    opened.resultLine({ result: '{"answer":42}' });

    await expect(opened.settled()).resolves.toMatchObject({ structured: { answer: 42 } });
  });

  it("parses a fenced JSON answer", async () => {
    const opened = await openTurn({ outputSchema: { type: "object" } });
    opened.resultLine({ result: 'Here you go:\n```json\n{"answer":7}\n```\nThanks' });

    await expect(opened.settled()).resolves.toMatchObject({ structured: { answer: 7 } });
  });

  it("falls back to the fenced block when the whole text is not JSON", async () => {
    const opened = await openTurn({ outputSchema: { type: "object" } });
    opened.resultLine({ result: 'prefix {"broken": }\n```\n{"ok":true}\n```' });

    await expect(opened.settled()).resolves.toMatchObject({ structured: { ok: true } });
  });

  it("leaves structured off when nothing parses", async () => {
    const opened = await openTurn({ outputSchema: { type: "object" } });
    opened.resultLine({ result: "no json here" });

    await expect(opened.settled()).resolves.not.toHaveProperty("structured");
  });

  it("prefers the CLI's own structured_output over parsing", async () => {
    const opened = await openTurn({ outputSchema: { type: "object" } });
    opened.resultLine({ structured_output: { fromCli: true }, result: '{"answer":1}' });

    await expect(opened.settled()).resolves.toMatchObject({ structured: { fromCli: true } });
  });
});
