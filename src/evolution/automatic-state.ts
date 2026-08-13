import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { AutomaticEvaluationSuiteRecord } from "./automation.js";

/** Durable automatic-controller state document version. */
export const AUTOMATIC_CONTROLLER_STATE_VERSION = 1 as const;

/** Sidecar filename under `<stateDirectory>/evolution/`. */
export const AUTOMATIC_CONTROLLER_STATE_FILENAME = "automatic-controller.json" as const;

/**
 * Small durable sidecar for AutomaticEvolutionController state that must
 * survive a control-service restart. Unlike the evolution catalog this file
 * is advisory: a corrupt or invalid document is discarded (the field falls
 * back to null) instead of blocking startup.
 *
 * Writes follow the repository durable-file discipline: unique `wx` temporary
 * file, mode 0600, file fsync, rename, then directory fsync. Saves are
 * serialized through a self-healing queue so one failed write cannot poison
 * later ones.
 */
export class AutomaticEvolutionStateStore {
  readonly filePath: string;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(readonly evolutionDirectory: string) {
    this.filePath = path.join(evolutionDirectory, AUTOMATIC_CONTROLLER_STATE_FILENAME);
  }

  /**
   * Load the persisted last-evaluation record. Returns null when the document
   * is absent, corrupt, or fails validation; never blocks startup on bad data.
   */
  async loadLastEvaluation(): Promise<AutomaticEvaluationSuiteRecord | null> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (!isNotFound(error)) {
        console.warn(
          `[evolution-automation] unable to read automatic controller state at ${this.filePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return null;
    }
    const record = parseLastEvaluationDocument(contents);
    if (record === undefined) {
      console.warn(
        `[evolution-automation] discarding invalid automatic controller state at ${this.filePath}`,
      );
      return null;
    }
    return record;
  }

  async saveLastEvaluation(record: AutomaticEvaluationSuiteRecord): Promise<void> {
    const serialized = `${JSON.stringify(
      { version: AUTOMATIC_CONTROLLER_STATE_VERSION, lastEvaluation: record },
      null,
      2,
    )}\n`;
    const result = this.saveQueue.catch(() => undefined).then(async () => {
      await mkdir(this.evolutionDirectory, { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporaryPath, "wx", 0o600);
        try {
          await handle.writeFile(serialized, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporaryPath, this.filePath);
        await syncDirectory(this.evolutionDirectory);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.saveQueue = result.then(
      () => undefined,
      () => undefined,
    );
    await result;
  }
}

/**
 * Parse a durable document into the last-evaluation record.
 * Returns null for a valid document without a record, undefined for any
 * corrupt or invalid document.
 */
export function parseLastEvaluationDocument(
  contents: string,
): AutomaticEvaluationSuiteRecord | null | undefined {
  let document: unknown;
  try {
    document = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) return undefined;
  const record = document as Record<string, unknown>;
  if (record.version !== AUTOMATIC_CONTROLLER_STATE_VERSION) return undefined;
  const value = record.lastEvaluation;
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  const expectedKeys = ["suiteName", "suiteDigest", "completedAt"];
  if (
    Object.keys(entry).length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.hasOwn(entry, key))
  ) {
    return undefined;
  }
  if (typeof entry.suiteName !== "string" || !entry.suiteName.trim()) return undefined;
  if (typeof entry.suiteDigest !== "string" || !/^[a-f0-9]{64}$/.test(entry.suiteDigest)) {
    return undefined;
  }
  if (typeof entry.completedAt !== "string" || Number.isNaN(Date.parse(entry.completedAt))) {
    return undefined;
  }
  return {
    suiteName: entry.suiteName,
    suiteDigest: entry.suiteDigest,
    completedAt: entry.completedAt,
  };
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** Mirrors the directory-fsync discipline of src/evolution/persistence.ts. */
async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (
      process.platform === "win32" &&
      (code === "EINVAL" || code === "ENOTSUP" || code === "EISDIR" || code === "EPERM")
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}
