import { describe, expect, it } from "vitest";
import {
  CodexAppServerSession,
  appServerArguments,
  toolSummary,
  totalsFrom,
} from "../src/sessions/codex-session.js";
import type { SessionEvent } from "../src/sessions/types.js";

/**
 * The protocol handlers are pure functions of a JSON-RPC line and the session
 * state, so they are exercised here without spawning the app server.
 */
function session(): {
  session: CodexAppServerSession;
  events: SessionEvent[];
  written: string[];
} {
  const events: SessionEvent[] = [];
  const written: string[] = [];
  const instance = Object.create(CodexAppServerSession.prototype) as CodexAppServerSession;
  // Token totals are read by buildResult; every turn needs them present.
  Object.assign(instance, { totals: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } });
  Object.assign(instance, {
    hub: { emit: (event: SessionEvent) => events.push(event), subscribe: () => () => undefined },
    questions: new Map(),
    active: {
      turnId: "turn-1",
      startedAt: Date.now(),
      finalText: undefined,
      lastText: "",
      usageBaseline: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      structured: false,
      done: { resolve: () => undefined, reject: () => undefined, promise: Promise.resolve() },
    },
  });
  (instance as unknown as { respond: (id: unknown, body: unknown) => void }).respond = (id, body) => {
    written.push(JSON.stringify({ id, ...(body as object) }));
  };
  (instance as unknown as { respondError: (id: unknown, message: string) => void }).respondError = (
    id,
    message,
  ) => {
    written.push(JSON.stringify({ id, error: message }));
  };
  return { session: instance, events, written };
}

function notify(target: CodexAppServerSession, method: string, params: Record<string, unknown> = {}) {
  (target as unknown as { handleNotification: (m: string, p: unknown) => void }).handleNotification(
    method,
    params,
  );
}

function request(
  target: CodexAppServerSession,
  id: number | string,
  method: string,
  params: Record<string, unknown> = {},
) {
  (target as unknown as { handleServerRequest: (i: unknown, m: string, p: unknown) => void }).handleServerRequest(
    id,
    method,
    params,
  );
}

describe("codex app-server notifications", () => {
  it("announces a started turn and streams deltas", () => {
    const { session: target, events } = session();
    notify(target, "turn/started", { turn: { id: "turn-9" } });
    notify(target, "item/agentMessage/delta", { delta: "hello" });
    expect(events).toEqual([
      { type: "turn-started", turnId: "turn-9" },
      { type: "text-delta", turnId: "turn-1", text: "hello" },
    ]);
  });

  it("ignores a turn start without a turn id or an active turn", () => {
    const { session: target, events } = session();
    notify(target, "turn/started", {});
    expect(events).toEqual([]);
  });

  it("emits agent messages only when completed", () => {
    const { session: target, events } = session();
    notify(target, "item/started", { item: { type: "agentMessage", text: "draft" } });
    notify(target, "item/completed", {
      item: { type: "agentMessage", text: "final", phase: "final_answer" },
    });
    expect(events).toEqual([
      { type: "message", turnId: "turn-1", text: "final", final: true },
    ]);
  });

  it("skips informational items and reports tools with their status", () => {
    const { session: target, events } = session();
    notify(target, "item/started", { item: { type: "reasoning" } });
    notify(target, "item/started", { item: { type: "commandExecution", id: "c1", command: "ls" } });
    notify(target, "item/completed", {
      item: { type: "commandExecution", id: "c1", command: "ls", status: "failed" },
    });
    expect(events.map((event) => event.type)).toEqual(["tool", "tool"]);
    expect(events[0]).toMatchObject({ status: "started" });
    expect(events[1]).toMatchObject({ status: "failed" });
  });

  it("reports errors and warnings as notices", () => {
    const { session: target, events } = session();
    notify(target, "error", { error: { message: "boom" } });
    notify(target, "warning", { message: "careful" });
    notify(target, "error", {});
    expect(events).toEqual([
      { type: "notice", level: "error", message: "boom" },
      { type: "notice", level: "warning", message: "careful" },
      { type: "notice", level: "error", message: "app-server error" },
    ]);
  });

  it("ignores unknown notifications", () => {
    const { session: target, events } = session();
    notify(target, "something/else", {});
    expect(events).toEqual([]);
  });
});

describe("codex app-server requests", () => {
  it("asks the operator and records the pending questions", () => {
    const { session: target, events } = session();
    request(target, 7, "item/tool/requestUserInput", {
      questions: [
        { id: "q1", question: "继续吗？", options: [{ label: "是" }, { label: "否" }] },
        { id: "q2", header: "口令", isSecret: true },
      ],
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "question", questionId: "7:q1", options: ["是", "否"] });
    expect(events[1]).toMatchObject({ questionId: "7:q2", secret: true, prompt: "口令" });
  });

  it("declines approvals instead of granting them", () => {
    const { session: target, events, written } = session();
    request(target, 3, "item/commandExecution/requestApproval");
    expect(written[0]).toContain('"decision":"decline"');
    expect(events[0]).toMatchObject({ type: "notice", level: "warning" });
  });

  it("denies patch and exec approvals, and answers the other requests", () => {
    const { session: target, written } = session();
    request(target, 1, "applyPatchApproval");
    request(target, 2, "execCommandApproval");
    request(target, 3, "item/permissions/requestApproval");
    request(target, 4, "mcpServer/elicitation/request");
    expect(written).toEqual([
      expect.stringContaining('"decision":"denied"'),
      expect.stringContaining('"decision":"denied"'),
      expect.stringContaining('"permissions":{}'),
      expect.stringContaining('"action":"decline"'),
    ]);
  });

  it("rejects an unsupported request with an error reply", () => {
    const { session: target, written } = session();
    request(target, 9, "unknown/method");
    expect(written[0]).toContain("unsupported server request");
  });
});

describe("codex turn completion", () => {
  it("completes through the notification path in one call", () => {
    const { session: target } = session();
    const settled: unknown[] = [];
    Object.assign((target as unknown as { active: Record<string, unknown> }).active, {
      done: { resolve: (value: unknown) => settled.push(value), reject: () => undefined },
    });
    target.completeTurn(
      (target as unknown as { active: never }).active,
      { id: "turn-1", status: "completed", items: [{ type: "agentMessage", text: "ok" }] },
    );
    expect(settled).toHaveLength(1);
  });
});

describe("codex turn outcomes", () => {
  it("carries the turn id, status and a failure payload", () => {
    const { session: target } = session();
    const settled: unknown[] = [];
    Object.assign((target as unknown as { active: Record<string, unknown> }).active, {
      done: { resolve: (value: unknown) => settled.push(value), reject: () => undefined },
    });
    target.completeTurn((target as unknown as { active: never }).active, {
      id: "turn-1",
      status: "failed",
      error: { message: "boom" },
    });
    expect(settled).toHaveLength(1);
    expect(JSON.stringify(settled[0])).toContain("boom");
  });
});

describe("codex helpers", () => {
  it("summarizes each tool kind", () => {
    expect(toolSummary("commandExecution", { command: "pnpm test" })).toBe("pnpm test");
    expect(toolSummary("webSearch", { query: "docs" })).toBe("docs");
    expect(
      toolSummary("fileChange", { changes: [{ path: "a.ts" }, { path: "b.ts" }] }),
    ).toBe("a.ts, b.ts");
    expect(toolSummary("fileChange", { changes: [] })).toBeUndefined();
    expect(toolSummary("unknown", {})).toBeUndefined();
    expect(toolSummary("commandExecution", { command: "" })).toBeUndefined();
  });

  it("reads token totals and defaults missing counters", () => {
    expect(totalsFrom({ inputTokens: 5, outputTokens: 2 })).toEqual({
      inputTokens: 5,
      cachedInputTokens: 0,
      outputTokens: 2,
    });
  });

  it("builds the app-server arguments with isolation flags", () => {
    const isolated = appServerArguments(
      { externalTools: "deny", permission: "read-only" } as never,
      "/repo",
    );
    expect(isolated[0]).toBe("app-server");
    expect(isolated).toContain("project_root_markers=[]");
    expect(isolated.join(" ")).toContain('trust_level="untrusted"');

    const open = appServerArguments({ externalTools: "allow" } as never, "/repo");
    expect(open).toEqual(["app-server"]);
  });
});

describe("codex protocol failures", () => {
  it("warns about an unparseable line and routes replies to waiters", () => {
    const { session: target, events, written } = session();
    (target as unknown as { handleLine: (line: string) => void }).handleLine("not json");
    expect(events[0]).toMatchObject({ type: "notice", level: "warning" });

    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
    let resolved: unknown;
    pending.set(1, { resolve: (value) => (resolved = value), reject: () => undefined });
    Object.assign(target, { pending, proc: { write: (line: string) => written.push(line) } });
    (target as unknown as { handleLine: (line: string) => void }).handleLine(
      JSON.stringify({ id: 1, result: { ok: true } }),
    );
    expect(resolved).toEqual({ ok: true });

    let rejected: unknown;
    pending.set(2, { resolve: () => undefined, reject: (error) => (rejected = error) });
    (target as unknown as { handleLine: (line: string) => void }).handleLine(
      JSON.stringify({ id: 2, error: { message: "nope" } }),
    );
    expect(String(rejected)).toContain("nope");
  });

  it("emits usage after a token total", () => {
    const { session: target, events } = session();
    target.handleUsage({ tokenUsage: { total: { inputTokens: 10, outputTokens: 4 } } });
    expect(events[0]).toMatchObject({ type: "usage", usage: { inputTokens: 10, outputTokens: 4 } });
    target.handleUsage({});
    expect(events).toHaveLength(1);
  });

  it("settles a completed turn and adopts its final item", () => {
    const { session: target, events } = session();
    const done = { settled: undefined as unknown };
    Object.assign((target as unknown as { active: Record<string, unknown> }).active, {
      done: { resolve: (value: unknown) => (done.settled = value), reject: () => undefined },
    });
    target.handleTurnCompleted({
      turn: { id: "turn-1", status: "completed", items: [{ type: "agentMessage", text: "done" }] },
    });
    expect(events[0]).toMatchObject({ type: "turn-completed", status: "completed" });
    expect(done.settled).toMatchObject({ status: "completed", text: "done" });
  });

  it("reports a failed turn with its error and ignores other turns", () => {
    const { session: target, events } = session();
    Object.assign((target as unknown as { active: Record<string, unknown> }).active, {
      done: { resolve: () => undefined, reject: () => undefined },
    });
    target.handleTurnCompleted({ turn: { id: "other", status: "completed" } });
    expect(events).toEqual([]);
    target.handleTurnCompleted({ turn: { id: "turn-1", status: "failed", error: { message: "boom" } } });
    expect(events[0]).toMatchObject({ status: "failed" });
  });

  it("settles a completed turn through the notification path", () => {
    const { session: target, events } = session();
    const settled: unknown[] = [];
    Object.assign((target as unknown as { active: Record<string, unknown> }).active, {
      done: { resolve: (value: unknown) => settled.push(value), reject: () => undefined },
    });
    notify(target, "turn/completed", {
      turn: { id: "turn-1", status: "interrupted", items: [{ type: "agentMessage", text: "stopped" }] },
    });
    expect(events[0]).toMatchObject({ type: "turn-completed", status: "interrupted" });
    expect(settled).toHaveLength(1);
  });

  it("answers a reply for an unknown or string id without throwing", () => {
    const { session: target } = session();
    Object.assign(target, { pending: new Map() });
    (target as unknown as { handleLine: (line: string) => void }).handleLine(
      JSON.stringify({ id: 42, result: { ok: true } }),
    );
    (target as unknown as { handleLine: (line: string) => void }).handleLine(
      JSON.stringify({ id: "abc", result: { ok: true } }),
    );
    (target as unknown as { handleLine: (line: string) => void }).handleLine(JSON.stringify({}));
    expect(true).toBe(true);
  });

  it("reports a spawn failure and a signal in the exit reason", () => {
    const { session: target } = session();
    const rejections: unknown[] = [];
    Object.assign(target, {
      pending: new Map([[1, { resolve: () => undefined, reject: (e: unknown) => rejections.push(e) }]]),
      proc: { stderrTail: () => "" },
    });
    (target as unknown as { handleExit: (c: number | null, s: string | null, e?: Error) => void }).handleExit(
      null,
      "SIGKILL",
    );
    expect(String(rejections[0])).toContain("SIGKILL");

    const second = session();
    Object.assign(second.session, {
      pending: new Map([[2, { resolve: () => undefined, reject: (e: unknown) => rejections.push(e) }]]),
      proc: { stderrTail: () => "" },
    });
    (second.session as unknown as {
      handleExit: (c: number | null, s: string | null, e?: Error) => void;
    }).handleExit(null, null, new Error("ENOENT"));
    expect(String(rejections[1])).toContain("could not start codex");
  });

  it("fails every waiter when the process exits", () => {
    const { session: target } = session();
    const pending = new Map<number, { resolve: () => void; reject: (error: unknown) => void }>();
    let rejection: unknown;
    pending.set(1, { resolve: () => undefined, reject: (error) => (rejection = error) });
    Object.assign(target, { pending, proc: { stderrTail: () => "stderr tail" } });
    (target as unknown as { handleExit: (c: number, s: string, e?: Error) => void }).handleExit(1, null);
    expect(String(rejection)).toContain("codex app-server exited");
  });
});
