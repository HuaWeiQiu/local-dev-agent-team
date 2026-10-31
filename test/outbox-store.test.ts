import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OutboxStore } from "../src/authority/outbox-store.js";
import { markSent, receiptFor, type EnqueueInput } from "../src/authority/outbox.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

async function makeStore(): Promise<OutboxStore> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-outbox-"));
  roots.push(root);
  return new OutboxStore(path.join(root, "authority", "outbox.json"));
}

const input = (patch: Partial<EnqueueInput> = {}): EnqueueInput => ({
  purpose: "acknowledgement",
  subjectId: "tk1",
  channel: { sourceKind: "github", sourceInstanceId: "acme/demo", threadId: "pull/7" },
  body: "on it",
  at: "2026-01-01T00:00:00.000Z",
  ...patch,
});

describe("OutboxStore", () => {
  it("is empty when the file is missing", async () => {
    const store = await makeStore();
    expect(await store.list()).toEqual([]);
  });

  it("reads back a receipt, and its state after a send", async () => {
    const store = await makeStore();
    const receipt = receiptFor(input());
    await store.save(receipt);
    await store.save(markSent(receipt, "2026-01-01T01:00:00.000Z"));
    const loaded = await store.get(receipt.id);
    expect(loaded).toMatchObject({ state: "sent", attempts: 1 });
    expect(await store.list()).toHaveLength(1);
  });

  it("keeps different messages apart", async () => {
    const store = await makeStore();
    await store.save(receiptFor(input()));
    await store.save(receiptFor(input({ purpose: "result" })));
    expect(await store.list()).toHaveLength(2);
  });
});
