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
  const dirs = transcriptDirs(artifacts);
  const completed = completedInvocations(events);
  return [...dirs.entries()]
    .map(([dir, info]) => summaryFor(dir, info, completed))
    .sort((left, right) => left.artifactKey.localeCompare(right.artifactKey));
}

/** Directories that hold a session or stdout log, with their total size. */
function transcriptDirs(artifacts: readonly EvidenceArtifact[]): Map<string, { bytes: number; live: boolean }> {
  const dirs = new Map<string, { bytes: number; live: boolean }>();
  for (const artifact of artifacts) {
    const located = locateLog(artifact);
    if (!located) continue;
    const entry = dirs.get(located.dir) ?? { bytes: 0, live: false };
    entry.bytes += artifact.size;
    if (located.live) entry.live = true;
    dirs.set(located.dir, entry);
  }
  return dirs;
}

function locateLog(artifact: EvidenceArtifact): { dir: string; live: boolean } | undefined {
  const segments = artifact.path.split("/");
  const name = segments.pop();
  if (name !== "stdout.log" && name !== "session.jsonl") return undefined;
  if (segments.length < 2) return undefined;
  return { dir: segments.join("/"), live: name === "session.jsonl" };
}

type Completion = { role?: string; success?: boolean; durationMs?: number; profile?: string };

/** The last completion per artifact key + profile, used to enrich a summary. */
function completedInvocations(events: readonly RunEvent[]): Map<string, Completion> {
  const completed = new Map<string, Completion>();
  for (const event of events) {
    if (event.type !== "agent.invocation.completed") continue;
    const payload = event.payload as Completion & { artifactKey?: string };
    if (payload.artifactKey && payload.profile) {
      completed.set(`${payload.artifactKey}/${payload.profile}`, payload);
    }
  }
  return completed;
}

function summaryFor(
  dir: string,
  info: { bytes: number; live: boolean },
  completed: Map<string, Completion>,
): TranscriptSummary {
  const segments = dir.split("/");
  const artifactKey = segments.slice(0, -1).join("/");
  return {
    id: dir,
    artifactKey,
    profile: segments.at(-1)!,
    live: info.live,
    bytes: info.bytes,
    ...completionFields(completed.get(dir), artifactKey),
  };
}

/** Only the fields a completed invocation actually reported are copied. */
function completionFields(
  seen: Completion | undefined,
  artifactKey: string,
): Partial<TranscriptSummary> {
  const taskId = taskIdFromArtifactKey(`${artifactKey}/`);
  return {
    ...(seen?.role ? { role: seen.role } : {}),
    ...(taskId ? { taskId } : {}),
    ...(seen?.success !== undefined ? { success: seen.success } : {}),
    ...(seen?.durationMs !== undefined ? { durationMs: seen.durationMs } : {}),
  };
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
    const event = parseLine(line);
    if (!event) continue;
    const entry = lineEntry(event, entries, toolIndex);
    if (entry === "replace") continue;
    if (entry) entries.push(entry);
  }
  return entries;
}

function parseLine(line: string): SessionLine | undefined {
  if (!line.trim()) return undefined;
  try {
    return JSON.parse(line) as SessionLine;
  } catch {
    return undefined;
  }
}

/** One log line → an entry to append, "replace" when it updated an existing tool, or nothing. */
function lineEntry(
  event: SessionLine,
  entries: TranscriptEntry[],
  toolIndex: Map<string, number>,
): TranscriptEntry | "replace" | undefined {
  const base = event.at === undefined ? {} : { at: String(event.at) };
  switch (event.type) {
    case "message":
      return finalMessage(event, base);
    case "tool":
      return toolEntry(event, base, entries, toolIndex);
    case "question":
      return questionEntry(event, base);
    case "notice":
      return noticeEntry(event, base);
    case "turn-started":
      return { ...base, kind: "turn", text: "turn started" };
    case "turn-completed":
      return completedTurn(event, base);
    default:
      return undefined;
  }
}

type Base = { at?: string };

function finalMessage(event: SessionLine, base: Base): TranscriptEntry | undefined {
  if (event.final !== true || typeof event.text !== "string") return undefined;
  return { ...base, kind: "message", text: clip(event.text) };
}

/** A repeated tool id updates the entry in place instead of appending. */
function toolEntry(
  event: SessionLine,
  base: Base,
  entries: TranscriptEntry[],
  toolIndex: Map<string, number>,
): TranscriptEntry | "replace" | undefined {
  const toolId = String(event.toolId ?? "");
  const existing = toolIndex.get(toolId);
  if (existing !== undefined && entries[existing]) {
    entries[existing] = { ...entries[existing], ...toolUpdate(event) };
    return "replace";
  }
  toolIndex.set(toolId, entries.length);
  return {
    ...base,
    kind: "tool",
    label: String(event.name ?? "tool"),
    status: String(event.status ?? "started"),
    text: clip(toolText(event)),
  };
}

function toolUpdate(event: SessionLine): Partial<TranscriptEntry> {
  return {
    status: String(event.status ?? "started"),
    ...(typeof event.summary === "string" ? { text: clip(event.summary) } : {}),
  };
}

function toolText(event: SessionLine): string {
  return typeof event.summary === "string" ? event.summary : String(event.name ?? "tool");
}

function questionEntry(event: SessionLine, base: Base): TranscriptEntry {
  return {
    ...base,
    kind: "question",
    text: clip(String(event.prompt ?? "")),
    ...(event.secret === true ? { label: "secret" } : {}),
  };
}

function noticeEntry(event: SessionLine, base: Base): TranscriptEntry {
  return {
    ...base,
    kind: "notice",
    label: String(event.level ?? "info"),
    text: clip(String(event.message ?? "")),
  };
}

function completedTurn(event: SessionLine, base: Base): TranscriptEntry {
  const status = String(event.status ?? "");
  return { ...base, kind: "turn", status, text: `turn ${String(event.status ?? "completed")}` };
}

const OPERATOR_EVENTS: Record<string, string> = {
  "agent.steered": "steer",
  "agent.interrupted": "interrupt",
  "agent.answered": "answer",
  "agent.stalled": "stall",
};

/** Operator and watchdog actions on the agents that wrote this transcript. */
export function operatorEntries(events: readonly RunEvent[], artifactKey: string): TranscriptEntry[] {
  const agentIds = agentsFor(events, artifactKey);
  if (agentIds.size === 0) return [];
  return events.flatMap((event) => operatorEntry(event, agentIds) ?? []);
}

/** The agents that opened a session for this transcript's artifact key. */
function agentsFor(events: readonly RunEvent[], artifactKey: string): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== "agent.session.opened") continue;
    const payload = event.payload as { agentId?: string; artifactKey?: string };
    if (payload.artifactKey === artifactKey && payload.agentId) ids.add(payload.agentId);
  }
  return ids;
}

interface OperatorPayload {
  agentId?: string;
  actor?: string;
  text?: string;
  note?: string;
  answer?: string;
  redacted?: boolean;
  idleSeconds?: number;
}

function operatorEntry(event: RunEvent, agentIds: Set<string>): TranscriptEntry[] | undefined {
  const label = OPERATOR_EVENTS[event.type];
  if (!label) return undefined;
  const payload = event.payload as OperatorPayload;
  if (!payload.agentId || !agentIds.has(payload.agentId)) return undefined;
  return [
    {
      kind: "notice",
      label,
      text: operatorText(label, payload),
      ...(event.occurredAt ? { at: event.occurredAt } : {}),
    },
  ];
}

const OPERATOR_TEXT: Record<string, (payload: OperatorPayload) => string> = {
  stall: (payload) => `no output for ${payload.idleSeconds ?? "?"}s, nudged to continue`,
  interrupt: (payload) => payload.note ?? "interrupted",
  answer: (payload) => visible(payload.answer, payload.redacted),
  steer: (payload) => visible(payload.text, payload.redacted),
};

function operatorText(label: string, payload: OperatorPayload): string {
  return OPERATOR_TEXT[label]?.(payload) ?? "";
}

function visible(value: string | undefined, redacted: boolean | undefined): string {
  return redacted === true ? "<redacted>" : value ?? "";
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
