import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamProcess, StreamProcessRequest } from "../src/process/stream.js";
import type { AgentProfile } from "../src/config/schema.js";

const { spawnCalls, resolveExit } = vi.hoisted(() => ({
  spawnCalls: [] as StreamProcessRequest[],
  resolveExit: [] as Array<
    (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
  >,
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
      write: () => true,
      closeStdin: () => undefined,
      terminate: () => undefined,
      exited,
      stderrTail: () => "tail of stderr",
    };
  },
}));

const { ClaudeStreamSession } = await import("../src/sessions/claude-session.js");

const minimalProfile: AgentProfile = {
  adapter: "claude",
  model: "inherit",
  reasoning: "high",
  permission: "workspace-write",
  externalTools: "inherit",
  timeoutSeconds: 60,
  args: [],
};

const fullProfile: AgentProfile = {
  adapter: "claude",
  model: "claude-sonnet-4-6",
  reasoning: "high",
  permission: "read-only",
  externalTools: "deny",
  timeoutSeconds: 60,
  args: ["--extra", "1"],
};

function session(
  patch: {
    profile?: AgentProfile;
    resumeSessionId?: string;
    sessionSchema?: Record<string, unknown>;
  } = {},
) {
  return new ClaudeStreamSession(
    {
      adapterName: "claude",
      root: "/tmp/repo",
      cwd: "/tmp/repo",
      profile: patch.profile ?? minimalProfile,
      ...(patch.resumeSessionId ? { resumeSessionId: patch.resumeSessionId } : {}),
      ...(patch.sessionSchema ? { sessionSchema: patch.sessionSchema } : {}),
    } as never,
    "claude",
  );
}

/** Starting a turn is what spawns the child, so every case opens one. */
async function startAndCaptureArgs(
  built: ReturnType<typeof session>,
): Promise<string[]> {
  const pending = built.runTurn({ prompt: "hi" }).catch(() => undefined);
  await Promise.resolve();
  const request = spawnCalls[spawnCalls.length - 1]!;
  resolveExit[resolveExit.length - 1]!({ exitCode: 0, signal: null });
  await pending;
  return request.args;
}

beforeEach(() => {
  spawnCalls.length = 0;
  resolveExit.length = 0;
});

describe("claude session argv", () => {
  it("pins the whole argv for a default profile", async () => {
    const args = await startAndCaptureArgs(session());

    expect(args).toEqual([
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "acceptEdits",
      "--permission-prompt-tool",
      "stdio",
      "--effort",
      "high",
    ]);
  });

  it("pins the whole argv when every optional flag fires at once", async () => {
    const args = await startAndCaptureArgs(
      session({
        profile: fullProfile,
        resumeSessionId: "native-1",
        sessionSchema: { type: "object" },
      }),
    );

    expect(args).toEqual([
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "plan",
      "--permission-prompt-tool",
      "stdio",
      "--effort",
      "high",
      // deny 策略没有 resume 能力，所以先关持久化，再用 --resume 接回旧会话。
      "--no-session-persistence",
      "--resume",
      "native-1",
      "--tools",
      "Read,Glob,Grep",
      "--disallowed-tools",
      "Edit,Write,NotebookEdit,Bash",
      "--model",
      "claude-sonnet-4-6",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--json-schema",
      '{"type":"object"}',
      "--extra",
      "1",
    ]);
  });

  it("keeps the native session when the profile inherits external tools", async () => {
    const args = await startAndCaptureArgs(
      session({ resumeSessionId: "native-2", profile: { ...minimalProfile, model: "x" } }),
    );

    expect(args).toContain("--resume");
    expect(args).not.toContain("--no-session-persistence");
    expect(args).toEqual(expect.arrayContaining(["--model", "x"]));
  });

  it("spawns the configured command in the project cwd", async () => {
    await startAndCaptureArgs(session());

    expect(spawnCalls.at(-1)).toMatchObject({ command: "claude", cwd: "/tmp/repo" });
  });

  it("starts the child only once for two turns", async () => {
    const built = session();
    await startAndCaptureArgs(built);
    const second = built.runTurn({ prompt: "again" }).catch(() => undefined);
    await Promise.resolve();
    resolveExit[resolveExit.length - 1]!({ exitCode: 0, signal: null });
    await second;

    expect(spawnCalls).toHaveLength(1);
  });
});

describe("claude session exit handling", () => {
  it("fails the live turn with the exit code and the stderr tail", async () => {
    const built = session();
    const pending = built.runTurn({ prompt: "hi" });
    await Promise.resolve();
    resolveExit[0]!({ exitCode: 3, signal: null });

    await expect(pending).rejects.toMatchObject({
      code: "process-exit",
      message: "claude exited (code 3): tail of stderr",
    });
  });

  it("names the signal when the child was killed", async () => {
    const built = session();
    const pending = built.runTurn({ prompt: "hi" });
    await Promise.resolve();
    resolveExit[0]!({ exitCode: null, signal: "SIGTERM" });

    await expect(pending).rejects.toMatchObject({
      message: "claude exited (code none, SIGTERM): tail of stderr",
    });
  });

  it("remembers a dead child for the next turn", async () => {
    const built = session();
    const pending = built.runTurn({ prompt: "hi" });
    await Promise.resolve();
    resolveExit[0]!({ exitCode: 1, signal: null });
    await pending.catch(() => undefined);

    await expect(built.runTurn({ prompt: "again" })).rejects.toMatchObject({
      code: "process-exit",
    });
  });
});
