import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { RunEvent } from "../events/types.js";
import type { EvidenceArtifact } from "../evidence/types.js";
import type { RunStateStore } from "../state/store.js";
import { taskIdFromArtifactKey } from "./usage.js";

const MAX_ENTRIES = 1_500;
const MAX_ENTRY_CHARS = 8_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface TranscriptSummary {
  /** Relative artifact directory; pass it back to read the transcript. */
  id: string;
  artifactKey: string;
  profile: string;
  role?: string;
  taskId?: string;
  live: boolean;
  success?: boolean;
  durationMs?: number;
  bytes: number;
}

export type TranscriptEntryKind =
  | "message"
  | "tool"
  | "question"
  | "notice"
  | "turn"
  | "operator"
  | "output";

export interface TranscriptEntry {
  kind: TranscriptEntryKind;
  at?: string;
  text: string;
  /** Tool name, operator action or notice level. */
  label?: string;
  status?: string;
}

export interface Transcript {
  id: string;
  entries: TranscriptEntry[];
  truncated: boolean;
}

/** Transcript directories are the ones that hold agent output. */
export function listTranscripts(
  artifacts: readonly EvidenceArtifact[],
  events: readonly RunEvent[],
): TranscriptSummary[] {
  const dirs = new Map<string, { bytes: number; live: boolean }>();
  for (const artifact of artifacts) {
    const segments = artifact.path.split("/");
    const name = segments.pop();
    if (name !== "stdout.log" && name !== "session.jsonl") continue;
    if (segments.length < 2) continue;
    const dir = segments.join("/");
    const entry = dirs.get(dir) ?? { bytes: 0, live: false };
    entry.bytes += artifact.size;
    if (name === "session.jsonl") entry.live = true;
    dirs.set(dir, entry);
  }

  const completed = new Map<string, { role?: string; success?: boolean; durationMs?: number; profile?: string }>();
  for (const event of events) {
    if (event.type !== "agent.invocation.completed") continue;
    const payload = event.payload as {
      artifactKey?: string;
      profile?: string;
      role?: string;
      success?: boolean;
      durationMs?: number;
    };
    if (payload.artifactKey && payload.profile) {
      completed.set(`${payload.artifactKey}/${payload.profile}`, payload);
    }
  }

  return [...dirs]
    .map(([dir, info]): TranscriptSummary => {
      const segments = dir.split("/");
      const profile = segments.at(-1)!;
      const artifactKey = segments.slice(0, -1).join("/");
      const seen = completed.get(dir);
      const taskId = taskIdFromArtifactKey(`${artifactKey}/`);
      return {
        id: dir,
        artifactKey,
        profile,
        live: info.live,
        bytes: info.bytes,
        ...(seen?.role ? { role: seen.role } : {}),
        ...(taskId ? { taskId } : {}),
        ...(seen?.success !== undefined ? { success: seen.success } : {}),
        ...(seen?.durationMs !== undefined ? { durationMs: seen.durationMs } : {}),
      };
    })
    .sort((left, right) => left.artifactKey.localeCompare(right.artifactKey));
}

function clip(text: string): string {
  return text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS)}\n[truncated]` : text;
}

interface SessionLine {
  at?: string;
  type?: string;
  [key: string]: unknown;
}

/** Turns the recorded session events into a readable conversation. */
export function parseSessionLog(raw: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const toolIndex = new Map<string, number>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: SessionLine;
    try {
      event = JSON.parse(line) as SessionLine;
    } catch {
      continue;
    }
    const at = typeof event.at === "string" ? event.at : undefined;
    const base = at ? { at } : {};
    switch (event.type) {
      case "message":
        if (event.final === true && typeof event.text === "string") {
          entries.push({ ...base, kind: "message", text: clip(event.text) });
        }
        break;
      case "tool": {
        const toolId = String(event.toolId ?? "");
        const status = String(event.status ?? "started");
        const text = typeof event.summary === "string" ? event.summary : String(event.name ?? "tool");
        const existing = toolIndex.get(toolId);
        if (existing !== undefined && entries[existing]) {
          entries[existing] = {
            ...entries[existing],
            status,
            text: typeof event.summary === "string" ? clip(event.summary) : entries[existing].text,
          };
        } else {
          toolIndex.set(toolId, entries.length);
          entries.push({ ...base, kind: "tool", label: String(event.name ?? "tool"), status, text: clip(text) });
        }
        break;
      }
      case "question":
        entries.push({
          ...base,
          kind: "question",
          text: clip(String(event.prompt ?? "")),
          ...(event.secret === true ? { label: "secret" } : {}),
        });
        break;
      case "notice":
        entries.push({
          ...base,
          kind: "notice",
          label: String(event.level ?? "info"),
          text: clip(String(event.message ?? "")),
        });
        break;
      case "turn-started":
        entries.push({ ...base, kind: "turn", text: "turn started" });
        break;
      case "turn-completed":
        entries.push({ ...base, kind: "turn", status: String(event.status ?? ""), text: `turn ${String(event.status ?? "completed")}` });
        break;
      default:
    }
  }
  return entries;
}

const OPERATOR_EVENTS: Record<string, string> = {
  "agent.steered": "steer",
  "agent.interrupted": "interrupt",
  "agent.answered": "answer",
  "agent.stalled": "stall",
};

/** Operator and watchdog actions on the agents that wrote this transcript. */
export function operatorEntries(events: readonly RunEvent[], artifactKey: string): TranscriptEntry[] {
  const agentIds = new Set(
    events
      .filter((event) => event.type === "agent.session.opened")
      .map((event) => event.payload as { agentId?: string; artifactKey?: string })
      .filter((payload) => payload.artifactKey === artifactKey && payload.agentId)
      .map((payload) => payload.agentId!),
  );
  if (agentIds.size === 0) return [];
  const entries: TranscriptEntry[] = [];
  for (const event of events) {
    const label = OPERATOR_EVENTS[event.type];
    if (!label) continue;
    const payload = event.payload as {
      agentId?: string;
      actor?: string;
      text?: string;
      note?: string;
      answer?: string;
      redacted?: boolean;
      idleSeconds?: number;
    };
    if (!payload.agentId || !agentIds.has(payload.agentId)) continue;
    const detail =
      label === "stall"
        ? `no output for ${payload.idleSeconds ?? "?"}s, nudged to continue`
        : (payload.text ?? payload.note ?? (payload.redacted ? "[redacted]" : payload.answer) ?? "");
    entries.push({
      kind: "operator",
      at: event.occurredAt,
      label,
      text: `${payload.actor ? `${payload.actor}: ` : ""}${clip(detail)}`.trim(),
    });
  }
  return entries;
}

function normalizeDirectory(directory: string): string[] {
  if (!directory || directory.includes("\0") || path.isAbsolute(directory)) {
    throw new Error("Transcript path must be relative");
  }
  const segments = directory.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Transcript path contains an invalid segment");
  }
  return segments;
}

async function readRegularFile(root: string, segments: string[], name: string): Promise<string | undefined> {
  let current = root;
  for (const segment of [...segments, name]) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error("Transcript path must not contain symbolic links");
    if (segment === name && !stats.isFile()) return undefined;
  }
  const contents = await readFile(current);
  return contents.subarray(0, MAX_FILE_BYTES).toString("utf8");
}

export async function readTranscript(
  states: RunStateStore,
  runId: string,
  directory: string,
  events: readonly RunEvent[],
): Promise<Transcript | undefined> {
  const segments = normalizeDirectory(directory);
  const root = states.artifactDirectory(runId);
  states.artifactDirectory(runId, ...segments);
  const session = await readRegularFile(root, segments, "session.jsonl");
  const stdout = await readRegularFile(root, segments, "stdout.log");
  if (session === undefined && stdout === undefined) return undefined;

  const entries = session ? parseSessionLog(session) : [];
  const hasFinalMessage = entries.some((entry) => entry.kind === "message");
  if (!hasFinalMessage && stdout?.trim()) {
    entries.push({ kind: "output", text: clip(stdout) });
  }
  const artifactKey = segments.slice(0, -1).join("/");
  const merged = [...entries, ...operatorEntries(events, artifactKey)].sort((left, right) => {
    if (!left.at || !right.at) return 0;
    return left.at.localeCompare(right.at);
  });
  const truncated = merged.length > MAX_ENTRIES;
  return { id: directory, entries: merged.slice(0, MAX_ENTRIES), truncated };
}
