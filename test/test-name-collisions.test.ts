import { describe, expect, it } from "vitest";
import { collisionKey, findCollisions, newCollisions } from "../scripts/test-name-collisions.mjs";

describe("test file name collisions", () => {
  it("flags two files whose stems match across extensions", () => {
    const found = findCollisions(["test/onboarding.test.ts", "test/web/onboarding.test.tsx"]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ reason: "same stem, different extension" });
  });

  it("leaves a suffix relationship alone", () => {
    // `doctor` inside `adapters-doctor` is ordinary naming; a first version that
    // flagged these produced 72 hits, nearly all noise.
    expect(findCollisions(["test/doctor.test.ts", "test/adapters-doctor.test.ts"])).toEqual([]);
  });

  it("leaves unrelated files alone", () => {
    expect(findCollisions(["test/a.test.ts", "test/b.test.ts"])).toEqual([]);
  });

  it("keys a pair the same way whichever order it is found in", () => {
    expect(collisionKey({ left: "b", right: "a" })).toBe(collisionKey({ left: "a", right: "b" }));
  });

  it("reports only the pairs the baseline does not already know", () => {
    const found = findCollisions([
      "test/onboarding.test.ts",
      "test/web/onboarding.test.tsx",
      "test/fresh.test.ts",
      "test/web/fresh.test.tsx",
    ]);
    const known = [collisionKey(found.find((c) => c.left.includes("onboarding"))!)];
    const fresh = newCollisions(found, known);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].left).toContain("fresh");
  });
});

describe("walking the test tree", () => {
  it("collects test files recursively and ignores everything else", async () => {
    const { mkdir, mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { walk } = await import("../scripts/test-name-collisions.mjs");
    const root = await mkdtemp(path.join(tmpdir(), "names-"));
    await mkdir(path.join(root, "test", "nested"), { recursive: true });
    await writeFile(path.join(root, "test", "a.test.ts"), "");
    await writeFile(path.join(root, "test", "nested", "b.test.tsx"), "");
    await writeFile(path.join(root, "test", "notes.md"), "");
    expect(walk(path.join(root, "test"), root).sort()).toEqual(["test/a.test.ts", "test/nested/b.test.tsx"]);
  });
});
