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
  writes.length = 0;
});

function controlWrites(): Array<Record<string, unknown>> {
  return writes
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((message) => message.type === "control_response");
}

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

describe("control requests", () => {
  function controlRequest(patch: Record<string, unknown>) {
    return JSON.stringify({ type: "control_request", request_id: "req-1", request: patch });
  }

  it("answers an unsupported control subtype with an error response and no event", async () => {
    const { events, line, finish } = await openTurn();

    line(controlRequest({ subtype: "something_else" }));

    expect(controlWrites()).toEqual([
      {
        type: "control_response",
        response: {
          subtype: "error",
          request_id: "req-1",
          error: "unsupported control request 'something_else'",
        },
      },
    ]);
    expect(events.some((event) => event.type === "question")).toBe(false);
    await finish();
  });

  it("turns each question into an event with its options and no write", async () => {
    const { events, line, finish } = await openTurn();

    line(controlRequest({
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      input: { questions: [
        { question: "which one?", options: [{ label: "a" }, { label: "b" }] },
        { question: "and why?" },
      ] },
    }));

    const questions = events.filter((event) => event.type === "question");
    expect(questions).toEqual([
      { type: "question", turnId: questions[0]!.turnId, questionId: "req-1::0", prompt: "which one?", options: ["a", "b"] },
      { type: "question", turnId: questions[1]!.turnId, questionId: "req-1::1", prompt: "and why?" },
    ]);
    expect(controlWrites()).toEqual([]);
    await finish();
  });

  it("sends the collected answers back as one allow response", async () => {
    const { built, line, finish } = await openTurn();
    line(controlRequest({
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      input: { questions: [{ question: "pick" }, { question: "why" }] },
    }));

    await built.answer("req-1::0", "first");
    expect(controlWrites()).toEqual([]);
    await built.answer("req-1::1", "second");

    expect(controlWrites()[0]).toMatchObject({
      type: "control_response",
      response: { subtype: "success", request_id: "req-1", response: { behavior: "allow" } },
    });
    expect(JSON.stringify(controlWrites()[0])).toContain("first");
    await finish();
  });

  it("denies a question tool without questions and warns the operator", async () => {
    const { events, line, finish } = await openTurn();

    line(controlRequest({ subtype: "can_use_tool", tool_name: "AskUserQuestion", input: {} }));

    expect(controlWrites()[0]).toMatchObject({
      response: {
        subtype: "success",
        request_id: "req-1",
        response: { behavior: "deny", message: "AskUserQuestion is not permitted for this role" },
      },
    });
    expect(events.find((event) => event.type === "notice")).toMatchObject({
      level: "warning",
      message: "denied AskUserQuestion: not allowed for this role",
    });
    await finish();
  });

  it("denies any other tool and warns the operator", async () => {
    const { events, line, finish } = await openTurn();

    line(controlRequest({ subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm -rf /" } }));

    expect(controlWrites()[0]).toMatchObject({
      response: {
        subtype: "success",
        request_id: "req-1",
        response: { behavior: "deny", message: "Bash is not permitted for this role" },
      },
    });
    expect(events.some((event) => event.type === "notice")).toBe(true);
    await finish();
  });
});
