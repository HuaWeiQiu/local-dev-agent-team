/**
 * Where Tickets live between runs.
 *
 * One JSON file per project, written the way the other stores write: serialise to
 * a temporary file, then rename over the target. A crash therefore leaves either
 * the old file or the new one, never half of each — which matters more here than
 * elsewhere, because a Ticket carries the authority a run continues under.
 *
 * The store is deliberately dumb: it reads and writes records. Every rule about
 * what a Ticket may do next stays in `ticket.ts`, so the two cannot disagree.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Ticket } from "./ticket.js";

interface TicketDocument {
  version: 1;
  tickets: Ticket[];
}

export class TicketStore {
  constructor(private readonly filePath: string) {}

  static pathFor(stateRoot: string): string {
    return path.join(stateRoot, "authority", "tickets.json");
  }

  /** Every Ticket, oldest first. A missing file is an empty store. */
  async list(): Promise<Ticket[]> {
    const document = await this.read();
    return document.tickets;
  }

  async get(id: string): Promise<Ticket | undefined> {
    const document = await this.read();
    return document.tickets.find((ticket) => ticket.id === id);
  }

  /** Write one Ticket, replacing the record with the same id if there is one. */
  async save(ticket: Ticket): Promise<void> {
    const document = await this.read();
    const tickets = document.tickets.filter((entry) => entry.id !== ticket.id);
    tickets.push(ticket);
    await this.write({ version: 1, tickets });
  }

  private async read(): Promise<TicketDocument> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<TicketDocument>;
      return {
        version: 1,
        tickets: Array.isArray(parsed.tickets) ? (parsed.tickets as Ticket[]) : [],
      };
    } catch (error) {
      if (isMissing(error)) return { version: 1, tickets: [] };
      throw error;
    }
  }

  private async write(document: TicketDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(temp, this.filePath);
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
