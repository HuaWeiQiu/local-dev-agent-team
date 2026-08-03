import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitManager } from "../src/git/manager.js";

describe("GitManager ownership", () => {
  it("accepts owned changes and rejects other paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-git-"));
    const worktrees = path.join(root, ".agent-team", "worktrees");
    await mkdir(worktrees, { recursive: true });
    const manager = new GitManager(root, worktrees);
    expect(() => manager.assertOwnedPaths(["src/api/index.ts"], ["src/api/**"])).not.toThrow();
    expect(() => manager.assertOwnedPaths(["src/web/index.ts"], ["src/api/**"])).toThrow(
      "outside task ownership",
    );
  });
});
