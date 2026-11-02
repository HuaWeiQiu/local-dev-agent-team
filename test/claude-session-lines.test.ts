import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamProcess, StreamProcessRequest } from "../src/process/stream.js";
import type { AgentProfile } from "../src/config/schema.js";

const { spawnCalls, resolveExit, deliver } = vi.hoisted(() => ({
  spawnCalls: [] as StreamProcessRequest[],
  resolveExit: [] as Array<
    (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
  >,
  deliver: [] as Array<(line: string) => void>,
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
      write: () => true,
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

/** Opens a turn and returns the line sink plus the events the session emitted. */
async function openTurn() {
  const built = session();
  const events: Array<Record<string, unknown>> = [];
  built.onEvent((event) => events.push(event as unknown as Record<string, unknown>));
  const pending = built.runTurn({ prompt: "go" }).catch(() => undefined);
  await Promise.resolve();
  const line = deliver[deliver.length - 1]!;
  return { built, events, line, finish: async () => {
    resolveExit[resolveExit.length - 1]!({ exitCode: 0, signal: null });
    await pending;
  } };
}

beforeEach(() => {
  spawnCalls.length = 0;
  resolveExit.length = 0;
  deliver.length = 0;
});

describe("streamed text deltas", () => {
  it("appends the delta and emits it", async () => {
    const { events, line, finish } = await openTurn();

    line(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "he" } } }));
    line(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "llo" } } }));

    expect(events.filter((e) => e.type === "text-delta").map((e) => e.text)).toEqual(["he", "llo"]);
    await finish();
  });

  it("ignores other block kinds and malformed deltas", async () => {
    const { events, line, finish } = await openTurn();

    line(JSON.stringify({ type: "stream_event", event: { type: "content_block_start" } }));
    line(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } } }));
    line(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: 7 } } }));

    expect(events.filter((e) => e.type === "text-delta")).toEqual([]);
    await finish();
  });
});

describe("assistant messages", () => {
  it("emits text blocks and tool starts", async () => {
    const { events, line, finish } = await openTurn();

    line(JSON.stringify({
      type: "assistant",
      message: { content: [
        { type: "text", text: "working on it" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } },
      ] },
    }));

    const message = events.find((e) => e.type === "message");
    const tool = events.find((e) => e.type === "tool");
    expect(message).toMatchObject({ text: "working on it", final: false });
    expect(tool).toMatchObject({ toolId: "t1", name: "Bash", status: "started", summary: "ls -la" });
    await finish();
  });

  it("leaves the summary off a tool with no summarisable input", async () => {
    const { events, line, finish } = await openTurn();

    line(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: {} }] } }));

    expect(events.find((e) => e.type === "tool")).not.toHaveProperty("summary");
    await finish();
  });

  it("skips empty text blocks and unknown block kinds", async () => {
    const { events, line, finish } = await openTurn();

    line(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "" }, { type: "thinking" }] } }));

    expect(events.some((e) => e.type === "message")).toBe(false);
    await finish();
  });
});

describe("tool results", () => {
  it("marks a completed and a failed tool result", async () => {
    const { events, line, finish } = await openTurn();

    line(JSON.stringify({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "t1" },
      { type: "tool_result", tool_use_id: "t2", is_error: true },
      { type: "text", text: "not a result" },
    ] } }));

    const tools = events.filter((e) => e.type === "tool");
    expect(tools.map((e) => [e.toolId, e.status])).toEqual([
      ["t1", "completed"],
      ["t2", "failed"],
    ]);
    await finish();
  });
});

describe("line dispatch", () => {
  it("records the native session id from an init message", async () => {
    const { built, line, finish } = await openTurn();

    line(JSON.stringify({ type: "system", subtype: "init", session_id: "native-9" }));

    expect(built.nativeSessionId).toBe("native-9");
    await finish();
  });

  it("ignores unknown message types and unparsable lines", async () => {
    const { events, line, finish } = await openTurn();

    line("not json at all");
    line(JSON.stringify({ type: "mystery" }));
    line(JSON.stringify({ type: "system", subtype: "other" }));

    // The turn-start event is the only thing this session announced.
    expect(events.map((event) => event.type)).toEqual(["turn-started"]);
    await finish();
  });
});
