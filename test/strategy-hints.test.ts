import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  StrategyHintStore,
  dedupe,
  hintForExperience,
  type StrategyHint,
} from "../src/experience/strategy-hints.js";
import type { ExperienceEntry } from "../src/experience/catalog.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

async function store(): Promise<StrategyHintStore> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-hints-"));
  roots.push(root);
  return new StrategyHintStore(path.join(root, "hints.json"));
}

function entry(patch: Record<string, unknown> = {}): ExperienceEntry {
  return {
    id: "e1",
    status: "verified",
    sensitivity: "low",
    summary: "顺序执行更稳",
    conditions: [],
    tags: [],
    ...patch,
  } as unknown as ExperienceEntry;
}

describe("hintForExperience", () => {
  it("ignores experiences that are not verified or not low sensitivity", () => {
    expect(hintForExperience(entry({ status: "proposed" }))).toBeUndefined();
    expect(hintForExperience(entry({ sensitivity: "high" }))).toBeUndefined();
  });

  it("reads the topology from any of the three text fields", () => {
    expect(hintForExperience(entry())).toEqual({ topology: "sequential", reworkHeavy: false });
    expect(hintForExperience(entry({ summary: "用 parallel-dag" }))).toMatchObject({
      topology: "parallel-dag",
    });
    expect(hintForExperience(entry({ summary: "无关", tags: ["依赖并行"] }))).toMatchObject({
      topology: "parallel-dag",
    });
    expect(hintForExperience(entry({ summary: "无关", conditions: ["返工多"] }))).toEqual({
      reworkHeavy: true,
    });
  });

  it("returns nothing when the text names neither", () => {
    expect(hintForExperience(entry({ summary: "普通经验" }))).toBeUndefined();
  });
});

describe("dedupe", () => {
  const hint = (patch: Partial<StrategyHint> = {}): StrategyHint => ({
    id: "h1",
    summary: "顺序执行更稳",
    sourceExperienceId: "e1",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  });

  it("puts the newest first and drops the same summary", () => {
    const kept = dedupe([hint({ id: "old" })], hint({ id: "new" }));
    expect(kept.map((item) => item.id)).toEqual(["new"]);
  });

  it("drops an entry with the same shape", () => {
    const kept = dedupe(
      [hint({ id: "old", summary: "另一条", topology: "sequential" })],
      hint({ id: "new", topology: "sequential" }),
    );
    expect(kept.map((item) => item.id)).toEqual(["new"]);
  });

  it("keeps a different shape", () => {
    const kept = dedupe(
      [hint({ id: "old", summary: "另一条", topology: "parallel-dag" })],
      hint({ id: "new", topology: "sequential" }),
    );
    expect(kept.map((item) => item.id)).toEqual(["new", "old"]);
  });
});

describe("StrategyHintStore.maybeRecordFromExperience", () => {
  it("records a derived hint and keeps it newest-first", async () => {
    const hints = await store();
    const first = await hints.maybeRecordFromExperience(entry({ id: "e1" }));
    expect(first).toMatchObject({ sourceExperienceId: "e1", topology: "sequential" });

    const second = await hints.maybeRecordFromExperience(
      entry({ id: "e2", summary: "返工太多", conditions: [], tags: [] }),
    );
    expect(second).toMatchObject({ maxParallel: 1 });

    const listed = await hints.list();
    expect(listed.map((item) => item.sourceExperienceId)).toEqual(["e2", "e1"]);
  });

  it("does not record an unsuitable experience", async () => {
    const hints = await store();
    expect(await hints.maybeRecordFromExperience(entry({ summary: "普通经验" }))).toBeUndefined();
    expect(await hints.list()).toEqual([]);
  });

  it("reads an empty list when the file is missing", async () => {
    expect(await (await store()).list()).toEqual([]);
  });

  it("tolerates a file without a hints array", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-hints-"));
    roots.push(root);
    const file = path.join(root, "hints.json");
    await writeFile(file, JSON.stringify({}), "utf8");
    expect(await new StrategyHintStore(file).list()).toEqual([]);
  });

  // The 32-hint cap only bites after many distinct shapes, which the public API
  // cannot produce; asserting it here would be a test of the slice, not of the store.
});
