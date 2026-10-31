import { createHash } from "node:crypto";
import type { ExperienceEntry } from "./catalog.js";

/**
 * Bridge between the curator-owned `agent-memory/reasoning-bank.md` file and the
 * durable experience catalog.
 *
 * The markdown file is written by the standalone post-run curator (the ACE
 * Reflector + Curator step described in the evolution plan). Until now it was
 * reachable only by an agent that chose to read it during a run, while the
 * orchestrator catalog retrieves nothing but explicitly promoted `verified`
 * entries — two parallel memory paths over the same facts.
 *
 * This module turns markdown entries into catalog *candidates*: one store, one
 * retrieval path, and the human promotion gate stays exactly where it was.
 * Nothing here may emit a `verified` entry.
 */

export interface ReasoningBankEntry {
  title: string;
  appliesWhen: string;
  strategy: string;
  source: string;
  status: "active" | "retired" | "unknown";
}

export interface ReasoningBankContext {
  project: string;
  /** Project-relative path of the markdown file, recorded as provenance. */
  sourcePath: string;
  now: string;
}

export interface ImportedExperience {
  /** Deterministic id derived from project + title, so re-imports are idempotent. */
  entry: ExperienceEntry;
  /** Provenance detail for the operator-facing report. */
  origin: { title: string; status: ReasoningBankEntry["status"] };
}

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const FIELD = /^[-*]\s*(applies when|strategy|source|status)\s*:\s*(.*)$/i;
const FENCE = /^\s*(?:```|~~~)/;
const ENTRY_HEADING_DEPTH = 3;

type DraftKey = "applies when" | "strategy" | "source" | "status";
type Draft = { title: string } & Partial<Record<DraftKey, string>>;

/**
 * Parse fenced-code-safe `### title` blocks with `- applies when:` style fields.
 * Incomplete blocks (no title or no strategy) are skipped: a half-remembered
 * entry is not worth injecting.
 */
export function parseReasoningBank(markdown: string): ReasoningBankEntry[] {
  const entries: ReasoningBankEntry[] = [];
  let current: Draft | null = null;
  let lastField: DraftKey | null = null;
  let inFence = false;

  const flush = (): void => {
    if (current) {
      const entry = finalizeEntry(current);
      if (entry) entries.push(entry);
    }
    current = null;
    lastField = null;
  };

  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      if (heading[1]?.length === ENTRY_HEADING_DEPTH) {
        current = { title: heading[2] ?? "" };
      }
      continue;
    }

    if (!current) continue;

    const field = FIELD.exec(line);
    if (field) {
      const key = field[1]?.toLowerCase() as DraftKey;
      const value = (field[2] ?? "").trim();
      const existing = current[key];
      current[key] = existing ? `${existing} ${value}` : value;
      lastField = key;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed === "---") {
      lastField = null;
      continue;
    }
    // Wrapped continuation of the previous field.
    if (lastField && current[lastField]) {
      current[lastField] = `${current[lastField]} ${trimmed}`;
    }
  }

  flush();
  return dedupeByTitle(entries);
}

/** Map parsed entries onto catalog candidates with deterministic ids. */
export function toExperienceEntries(
  entries: ReasoningBankEntry[],
  context: ReasoningBankContext,
): ImportedExperience[] {
  return entries.map((entry) => {
    const summary = truncate(`${entry.title} — ${entry.strategy}`, 2_000);
    const conditions = [
      entry.appliesWhen ? truncate(`applies when: ${entry.appliesWhen}`, 500) : null,
      entry.status === "retired" ? "markdown status: retired" : null,
    ].filter((value): value is string => Boolean(value));

    const tags = [
      "reasoning-bank",
      `source:${sourceKind(entry.source)}`,
      `status:${entry.status}`,
      truncate(`file:${context.sourcePath}`, 64),
    ];

    const candidate: ExperienceEntry = {
      id: stableExperienceId(context.project, entry.title),
      project: context.project,
      status: "candidate",
      summary,
      conditions,
      sourceRunId: `reasoning-bank:${digest(entry.title + "\u0000" + entry.strategy).slice(0, 12)}`,
      sensitivity: "low",
      scope: "project",
      portability: "project-bound",
      tags,
      hitCount: 0,
      successCount: 0,
      createdAt: context.now,
      updatedAt: context.now,
    };

    return { entry: candidate, origin: { title: entry.title, status: entry.status } };
  });
}

export function stableExperienceId(project: string, title: string): string {
  const hash = digest(`${project}\u0000${normalizeTitle(title)}`).slice(0, 32).split("");
  hash[12] = "5";
  const variant = (Number.parseInt(hash[16] ?? "0", 16) & 0x3) | 0x8;
  hash[16] = variant.toString(16);
  const joined = hash.join("");
  return [
    joined.slice(0, 8),
    joined.slice(8, 12),
    joined.slice(12, 16),
    joined.slice(16, 20),
    joined.slice(20, 32),
  ].join("-");
}

function finalizeEntry(draft: Draft): ReasoningBankEntry | null {
  const title = draft.title.trim();
  const strategy = (draft.strategy ?? "").trim();
  if (!title || !strategy) return null;
  return {
    title,
    appliesWhen: (draft["applies when"] ?? "").trim(),
    strategy,
    source: (draft.source ?? "").trim(),
    status: readStatus(draft.status),
  };
}

function readStatus(value: string | undefined): ReasoningBankEntry["status"] {
  const text = (value ?? "").trim();
  if (!text) return "unknown";
  if (/^active\b/i.test(text)) return "active";
  if (/^retired\b/i.test(text) || text.includes("已失效")) return "retired";
  return "unknown";
}

function sourceKind(value: string): "success" | "failure" | "unknown" {
  const text = value.trim().toLowerCase();
  if (text.startsWith("success")) return "success";
  if (text.startsWith("failure")) return "failure";
  return "unknown";
}

function dedupeByTitle(entries: ReasoningBankEntry[]): ReasoningBankEntry[] {
  const seen = new Set<string>();
  const result: ReasoningBankEntry[] = [];
  for (const entry of entries) {
    const key = normalizeTitle(entry.title);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
