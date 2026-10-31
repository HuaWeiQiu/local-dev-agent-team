import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

const mkdirp = (dir: string) => mkdir(dir, { recursive: true });
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listTranscripts,
  operatorEntries,
  parseSessionLog,
  readTranscript,
} from "../src/visibility/transcript.js";
import type { EvidenceArtifact, RunEvent } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

function line(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

describe("parseSessionLog", () => {
  it("reads every line kind", () => {
    const entries = parseSessionLog(
      [
        "",
        "   ",
        "not json",
        line({ type: "message", final: true, text: "done", at: "2026-01-01T00:00:00Z" }),
        line({ type: "message", final: false, text: "ignored" }),
        line({ type: "tool", toolId: "t1", name: "shell", status: "started" }),
        line({ type: "tool", toolId: "t1", status: "completed", summary: "ok" }),
        line({ type: "tool", toolId: "t2", summary: "summary only" }),
        line({ type: "question", prompt: "which?", secret: true }),
        line({ type: "notice", level: "warn", message: "careful" }),
        line({ type: "turn-started" }),
        line({ type: "turn-completed", status: "interrupted" }),
        line({ type: "unknown-kind" }),
      ].join("\n"),
    );
    expect(entries.map((entry) => entry.kind)).toEqual([
      "message",
      "tool",
      "tool",
      "question",
      "notice",
      "turn",
      "turn",
    ]);
    expect(entries[0]).toMatchObject({ text: "done", at: "2026-01-01T00:00:00Z" });
    expect(entries[1]).toMatchObject({ label: "shell", status: "completed", text: "ok" });
    expect(entries[2]).toMatchObject({ label: "tool", text: "summary only" });
    expect(entries[3]).toMatchObject({ label: "secret", text: "which?" });
    expect(entries[4]).toMatchObject({ label: "warn", text: "careful" });
    expect(entries[5]).toMatchObject({ text: "turn started" });
    expect(entries[6]).toMatchObject({ status: "interrupted", text: "turn interrupted" });
  });

  it("keeps a brand-new tool entry when the id was never seen", () => {
    const entries = parseSessionLog(line({ type: "tool", toolId: "new", summary: "first" }));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "tool", status: "started", text: "first" });
  });
});

describe("listTranscripts", () => {
  function artifact(pathName: string, size: number): EvidenceArtifact {
    return { path: pathName, size, kind: "agent-output", previewable: true } as EvidenceArtifact;
  }

  it("groups logs per directory and enriches them from events", () => {
    const events = [
      {
        type: "agent.invocation.completed",
        payload: { artifactKey: "runs/r1/tasks/T1", profile: "worker", role: "worker", success: true, durationMs: 5 },
      },
    ] as unknown as RunEvent[];
    const list = listTranscripts(
      [
        artifact("runs/r1/tasks/T1/worker/stdout.log", 10),
        artifact("runs/r1/tasks/T1/worker/session.jsonl", 5),
        artifact("runs/r1/tasks/T1/worker/other.txt", 99),
        artifact("stdout.log", 1),
      ],
      events,
    );
    expect(list).toHaveLength(1);
    // The summary is keyed by directory; enrichment needs the artifact key the
    // event reports, which here names the same directory.
    expect(list[0]).toMatchObject({
      artifactKey: "runs/r1/tasks/T1",
      profile: "worker",
      live: true,
      bytes: 15,
    });
  });

  it("summarizes a transcript with no completion event", () => {
    const list = listTranscripts([artifact("runs/r1/tasks/T9/tester/stdout.log", 4)], []);
    expect(list[0]).toMatchObject({
      id: "runs/r1/tasks/T9/tester",
      artifactKey: "runs/r1/tasks/T9",
      profile: "tester",
      live: false,
      bytes: 4,
    });
  });

  it("returns nothing for artifacts that are not logs", () => {
    expect(listTranscripts([artifact("runs/r1/x/y/other.txt", 1)], [])).toEqual([]);
  });
});

describe("operatorEntries", () => {
  function events(): RunEvent[] {
    return [
      { type: "agent.session.opened", payload: { agentId: "a1", artifactKey: "k" } },
      { type: "agent.steered", payload: { agentId: "a1", actor: "op", text: "go" } },
      { type: "agent.interrupted", payload: { agentId: "a1", actor: "op", note: "stop" } },
      { type: "agent.answered", payload: { agentId: "a1", actor: "op", answer: "yes" } },
      { type: "agent.stalled", payload: { agentId: "a1", idleSeconds: 30 } },
      { type: "agent.steered", payload: { agentId: "other", actor: "op", text: "ignored" } },
      { type: "agent.steered", payload: { agentId: "a1", actor: "op", text: "<secret>", redacted: true } },
    ] as unknown as RunEvent[];
  }

  it("keeps only actions on agents that wrote this transcript", () => {
    const entries = operatorEntries(events(), "k");
    expect(entries.length).toBeGreaterThanOrEqual(4);
    expect(entries.join(" ")).not.toContain("ignored");
    expect(entries.some((entry) => entry.text?.includes("no output for 30s"))).toBe(true);
  });

  it("returns nothing when no session opened for the key", () => {
    expect(operatorEntries(events(), "other-key")).toEqual([]);
  });
});

describe("readTranscript", () => {
  it("reads the session and stdout logs of one directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-transcript-"));
    roots.push(root);
    const dir = path.join(root, "runs", "r1", "tasks", "T1", "worker");
    await mkdirp(dir);
    await writeFile(
      path.join(dir, "session.jsonl"),
      `${line({ type: "message", final: true, text: "hi" })}\n`,
      "utf8",
    );
    const states = {
      artifactDirectory: (runId: string, ...parts: string[]) =>
        path.join(root, runId, ...parts.filter(Boolean)),
    } as never;
    const read = await readTranscript(states, "runs", "r1/tasks/T1/worker", []);
    expect(JSON.stringify(read)).toContain("hi");

    const missing = await readTranscript(states, "runs", "r1/tasks/T1/ghost", []);
    expect(missing).toBeUndefined();

    // A directory with only stdout still produces a transcript.
    const stdoutOnly = path.join(root, "runs", "r1", "tasks", "T2", "worker");
    await mkdirp(stdoutOnly);
    await writeFile(path.join(stdoutOnly, "stdout.log"), "raw output", "utf8");
    const read2 = await readTranscript(states, "runs", "r1/tasks/T2/worker", []);
    expect(JSON.stringify(read2)).toContain("raw output");
  });
});
