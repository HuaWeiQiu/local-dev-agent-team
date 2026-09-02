import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InquiryRecord } from "./domain.js";

/**
 * Independent, single-file storage for side-session inquiries. This store is
 * intentionally separate from RunStateStore: writing here can never mutate a
 * run's state.json, history, or event stream.
 */
export class InquiryStore {
  private readonly root: string;

  constructor(projectRoot: string, stateDirectory: string) {
    this.root = path.resolve(projectRoot, stateDirectory, "inquiries");
  }

  runDirectory(runId: string): string {
    assertInquiryId(runId);
    return path.join(this.root, runId);
  }

  async list(runId: string): Promise<InquiryRecord[]> {
    let entries: string[] = [];
    try {
      entries = await readdir(this.runDirectory(runId));
    } catch {
      return [];
    }
    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => {
          try {
            return await this.load(runId, entry.slice(0, -".json".length));
          } catch {
            return undefined;
          }
        }),
    );
    return records
      .filter((record): record is InquiryRecord => Boolean(record))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async load(runId: string, inquiryId: string): Promise<InquiryRecord> {
    assertInquiryId(inquiryId);
    const contents = await readFile(path.join(this.runDirectory(runId), `${inquiryId}.json`), "utf8");
    const record = JSON.parse(contents) as InquiryRecord;
    if (record.runId !== runId || record.id !== inquiryId) {
      throw new Error(`Inquiry '${inquiryId}' does not belong to run '${runId}'`);
    }
    return record;
  }

  async save(record: InquiryRecord): Promise<void> {
    const directory = this.runDirectory(record.runId);
    record.updatedAt = new Date().toISOString();
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, `${record.id}.json`);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  async delete(runId: string, inquiryId: string): Promise<void> {
    assertInquiryId(inquiryId);
    await rm(path.join(this.runDirectory(runId), `${inquiryId}.json`), { force: true });
  }

  /** Best-effort cascade when a run is deleted. */
  async deleteForRun(runId: string): Promise<void> {
    await rm(this.runDirectory(runId), { recursive: true, force: true });
  }
}

function assertInquiryId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) {
    throw new Error(`Invalid inquiry path id '${value}'`);
  }
}
