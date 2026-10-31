/**
 * Where the outbox lives between sends.
 *
 * Same shape as the Ticket store, and for the same reason: a receipt that is half
 * written is worse than one that is old, because the next attempt would read it to
 * decide whether it already spoke.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { OutboxMessage } from "./outbox.js";

interface OutboxDocument {
  version: 1;
  messages: OutboxMessage[];
}

export class OutboxStore {
  constructor(private readonly filePath: string) {}

  static pathFor(stateRoot: string): string {
    return path.join(stateRoot, "authority", "outbox.json");
  }

  async list(): Promise<OutboxMessage[]> {
    return (await this.read()).messages;
  }

  async get(id: string): Promise<OutboxMessage | undefined> {
    return (await this.read()).messages.find((message) => message.id === id);
  }

  /** Write one receipt, replacing the record with the same id. */
  async save(message: OutboxMessage): Promise<void> {
    const document = await this.read();
    const messages = document.messages.filter((entry) => entry.id !== message.id);
    messages.push(message);
    await this.write({ version: 1, messages });
  }

  private async read(): Promise<OutboxDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<OutboxDocument>;
      return {
        version: 1,
        messages: Array.isArray(parsed.messages) ? (parsed.messages as OutboxMessage[]) : [],
      };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { version: 1, messages: [] };
      }
      throw error;
    }
  }

  private async write(document: OutboxDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(temp, this.filePath);
  }
}
