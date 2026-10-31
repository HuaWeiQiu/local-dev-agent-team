import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExperienceEntry } from "./catalog.js";

export interface StrategyHint {
  id: string;
  summary: string;
  topology?: "sequential" | "parallel-dag";
  maxParallel?: number;
  sourceExperienceId: string;
  createdAt: string;
}

/** How many hints the store keeps; older ones fall off the end. */
const MAX_HINTS = 32;

/** The two shapes the hint text recognises. */
const SEQUENTIAL = /顺序|sequential/i;
const PARALLEL = /依赖并行|parallel-dag|并行/i;
const REWORK = /返工|rework/i;

interface HintDecision {
  topology?: "sequential" | "parallel-dag";
  reworkHeavy: boolean;
}

/**
 * Only a verified, low-sensitivity experience may steer the strategy, and only
 * when its text names a topology or a rework pattern.
 */
export function hintForExperience(entry: ExperienceEntry): HintDecision | undefined {
  if (entry.status !== "verified") return undefined;
  if (entry.sensitivity !== "low") return undefined;
  const text = [entry.summary, ...entry.conditions, ...entry.tags].join(" ");
  const topology = topologyOf(text);
  const reworkHeavy = REWORK.test(text);
  if (!topology && !reworkHeavy) return undefined;
  return { ...(topology ? { topology } : {}), reworkHeavy };
}

function topologyOf(text: string): HintDecision["topology"] {
  if (SEQUENTIAL.test(text)) return "sequential";
  return PARALLEL.test(text) ? "parallel-dag" : undefined;
}

/** The newest hint goes first; a duplicate summary or shape replaces the old one. */
export function dedupe(hints: readonly StrategyHint[], hint: StrategyHint): StrategyHint[] {
  const kept = hints.filter(
    (item) =>
      item.summary !== hint.summary &&
      !(item.topology === hint.topology && item.maxParallel === hint.maxParallel),
  );
  kept.unshift(hint);
  return kept;
}

export class StrategyHintStore {
  constructor(private readonly filePath: string) {}

  static pathFor(stateRoot: string): string {
    return path.join(stateRoot, "experience", "strategy-hints.json");
  }

  async list(): Promise<StrategyHint[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { hints?: StrategyHint[] };
      return Array.isArray(parsed.hints) ? parsed.hints : [];
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  /**
   * Derive a conservative strategy hint from a verified experience, if applicable.
   */
  async maybeRecordFromExperience(entry: ExperienceEntry): Promise<StrategyHint | undefined> {
    const decision = hintForExperience(entry);
    if (!decision) return undefined;
    const hint: StrategyHint = {
      id: randomUUID(),
      summary: entry.summary.slice(0, 240),
      ...(decision.topology ? { topology: decision.topology } : {}),
      ...(decision.reworkHeavy ? { maxParallel: 1 } : {}),
      sourceExperienceId: entry.id,
      createdAt: new Date().toISOString(),
    };
    const kept = dedupe(await this.list(), hint).slice(0, MAX_HINTS);
    await this.save(kept);
    return hint;
  }


  private async save(hints: StrategyHint[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 1, hints }, null, 2)}\n`, "utf8");
    await rename(temp, this.filePath);
  }
}
