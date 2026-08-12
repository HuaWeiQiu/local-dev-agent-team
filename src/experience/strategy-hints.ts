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
    if (entry.status !== "verified") return undefined;
    if (entry.sensitivity !== "low") return undefined;
    const text = [entry.summary, ...entry.conditions, ...entry.tags].join(" ");
    const topology = /顺序|sequential/i.test(text)
      ? ("sequential" as const)
      : /依赖并行|parallel-dag|并行/i.test(text)
        ? ("parallel-dag" as const)
        : undefined;
    const reworkHeavy = /返工|rework/i.test(text);
    if (!topology && !reworkHeavy) return undefined;

    const hint: StrategyHint = {
      id: randomUUID(),
      summary: entry.summary.slice(0, 240),
      ...(topology ? { topology } : {}),
      ...(reworkHeavy ? { maxParallel: 1 } : {}),
      sourceExperienceId: entry.id,
      createdAt: new Date().toISOString(),
    };
    const hints = await this.list();
    const deduped = hints.filter(
      (item) =>
        item.summary !== hint.summary &&
        !(item.topology === hint.topology && item.maxParallel === hint.maxParallel),
    );
    deduped.unshift(hint);
    await this.save(deduped.slice(0, 32));
    return hint;
  }

  private async save(hints: StrategyHint[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 1, hints }, null, 2)}\n`, "utf8");
    await rename(temp, this.filePath);
  }
}
