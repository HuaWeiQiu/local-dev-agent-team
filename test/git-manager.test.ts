import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitManager } from "../src/git/manager.js";
import { runProcess } from "../src/process/run.js";

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

  it("returns a bounded diff between validated commits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-git-diff-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "fixture@example.com"]);
    await git(root, ["config", "user.name", "Fixture"]);
    await writeFile(path.join(root, "file.txt"), "first\n", "utf8");
    await git(root, ["add", "file.txt"]);
    await git(root, ["commit", "-m", "first"]);
    const base = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(path.join(root, "file.txt"), "first\nsecond\n", "utf8");
    await git(root, ["commit", "-am", "second"]);
    const target = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    const manager = new GitManager(root, path.join(root, ".agent-team", "worktrees"));

    await expect(manager.diffBetween(base, target)).resolves.toMatchObject({
      changedFiles: ["file.txt"],
      content: expect.stringContaining("+second"),
      truncated: false,
    });
    await expect(manager.diffBetween("--output=/tmp/oops", target)).rejects.toThrow(
      "Invalid Git object ID",
    );
  });
});

async function git(root: string, args: string[]) {
  const result = await runProcess({ command: "git", args, cwd: root, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result;
}
