import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GitManager,
  GitManagerError,
  type ExactTrackedFileCommitAuthorization,
} from "../src/git/manager.js";
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

  it("treats a directory prefix as the whole tree without matching a sibling prefix", () => {
    const manager = new GitManager("/tmp", "/tmp/.agent-team/worktrees");
    const hostFiles = [
      "apps/photoshop-uxp/src/host/photoshop-glow-host.mjs",
      "apps/photoshop-uxp/src/host/source-pixel-hash.mjs",
      "apps/photoshop-uxp/tests/photoshop-glow-host.test.mjs",
      "apps/photoshop-uxp/tests/source-pixel-hash.test.mjs",
    ];
    expect(() =>
      manager.assertOwnedPaths(hostFiles, [
        "apps/photoshop-uxp/src/host/",
        "apps/photoshop-uxp/tests/",
      ]),
    ).not.toThrow();
    expect(() => manager.assertOwnedPaths(["src/apiv2/x.ts"], ["src/api"])).toThrow(
      "outside task ownership",
    );
    expect(() => manager.assertOwnedPaths(["README.md.bak"], ["README.md"])).toThrow(
      "outside task ownership",
    );
    expect(() => manager.assertOwnedPaths(["PROJECT_STATE.md"], ["PROJECT_STATE.md"])).not.toThrow();
    expect(() =>
      manager.assertOwnedPaths(["docs/runbooks/windows-host.md"], ["docs/runbooks/"]),
    ).not.toThrow();
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

describe("GitManager exact tracked-file commit", () => {
  it("authorizes only when the primary worktree is clean and the target is tracked", async () => {
    const { root, manager } = await createRepo();
    await expect(manager.authorizeExactTrackedFileCommit("prompts/worker.md")).resolves.toMatchObject({
      kind: "exact-tracked-file-commit",
      repositoryRelativePath: "prompts/worker.md",
    });

    await writeFile(path.join(root, "prompts", "worker.md"), "dirty\n", "utf8");
    await expect(manager.authorizeExactTrackedFileCommit("prompts/worker.md")).rejects.toMatchObject({
      code: "GIT_WORKTREE_CONTAMINATED",
    });

    await git(root, ["checkout", "--", "prompts/worker.md"]);
    await writeFile(path.join(root, "untracked.txt"), "x\n", "utf8");
    await expect(manager.authorizeExactTrackedFileCommit("prompts/worker.md")).rejects.toMatchObject({
      code: "GIT_WORKTREE_CONTAMINATED",
    });

    await git(root, ["config", "status.showUntrackedFiles", "no"]);
    await expect(manager.authorizeExactTrackedFileCommit("prompts/worker.md")).rejects.toMatchObject({
      code: "GIT_WORKTREE_CONTAMINATED",
    });
  });

  it("rejects exact-file authorization from a linked worktree", async () => {
    const { root } = await createRepo();
    const linkedRoot = `${root}-linked`;
    await git(root, ["worktree", "add", "-b", "linked-test", linkedRoot]);
    const linkedManager = new GitManager(
      linkedRoot,
      path.join(linkedRoot, ".agent-team", "worktrees"),
    );

    await expect(
      linkedManager.authorizeExactTrackedFileCommit("prompts/worker.md"),
    ).rejects.toMatchObject({ code: "GIT_UNSAFE_PATH" });
  });

  it("rejects unsafe, untracked, symlink, and non-normalized paths without mutating the index", async () => {
    const { root, manager } = await createRepo();
    const headBefore = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();

    await expect(manager.authorizeExactTrackedFileCommit("../outside.md")).rejects.toMatchObject({
      code: "GIT_UNSAFE_PATH",
    });
    await expect(manager.authorizeExactTrackedFileCommit("/tmp/abs.md")).rejects.toMatchObject({
      code: "GIT_UNSAFE_PATH",
    });
    await expect(manager.authorizeExactTrackedFileCommit("./prompts/worker.md")).rejects.toMatchObject({
      code: "GIT_UNSAFE_PATH",
    });
    await expect(manager.authorizeExactTrackedFileCommit("missing.md")).rejects.toMatchObject({
      code: "GIT_UNSAFE_PATH",
    });
    // Path-only rejections must not stage or commit anything.
    expect((await git(root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(headBefore);
    expect((await git(root, ["status", "--porcelain"])).stdout.trim()).toBe("");
    expect((await git(root, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe("");

    await writeFile(path.join(root, "new-untracked.md"), "new\n", "utf8");
    await expect(manager.authorizeExactTrackedFileCommit("new-untracked.md")).rejects.toMatchObject({
      code: "GIT_TARGET_NOT_TRACKED",
    });

    await symlink(path.join(root, "prompts", "worker.md"), path.join(root, "prompts", "link.md"));
    // Symlink may be untracked; either unsafe or not-tracked is acceptable fail-closed behavior.
    await expect(manager.authorizeExactTrackedFileCommit("prompts/link.md")).rejects.toBeInstanceOf(
      GitManagerError,
    );

    expect((await git(root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(headBefore);
    // Rejection path must not stage or commit the untracked/symlink entries.
    expect((await git(root, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe("");
    const status = (await git(root, ["status", "--porcelain"])).stdout;
    expect(status).toContain("?? new-untracked.md");
    expect(status).toContain("?? prompts/link.md");
    expect(status.split("\n").filter((line) => line && !line.startsWith("??"))).toEqual([]);
  });

  it("commits exactly one authorized tracked file after a clean-before-mutation authorization", async () => {
    const { root, manager } = await createRepo();
    const authorization = await manager.authorizeExactTrackedFileCommit("prompts/worker.md");
    const previousHead = authorization.head;

    await writeFile(path.join(root, "prompts", "worker.md"), "updated worker prompt\n", "utf8");
    const result = await manager.commitExactTrackedFile(
      authorization,
      "Apply exact tracked prompt mutation",
    );

    expect(result.path).toBe("prompts/worker.md");
    expect(result.previousHead).toBe(previousHead);
    expect(result.commit).not.toBe(previousHead);
    expect((await git(root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(result.commit);
    expect(await readFile(path.join(root, "prompts", "worker.md"), "utf8")).toBe(
      "updated worker prompt\n",
    );

    const show = await git(root, ["show", "--name-only", "--pretty=format:", "HEAD"]);
    expect(show.stdout.trim().split("\n").filter(Boolean)).toEqual(["prompts/worker.md"]);
    const message = (await git(root, ["log", "-1", "--pretty=%B"])).stdout.trim();
    expect(message).toBe("Apply exact tracked prompt mutation");
    expect((await git(root, ["status", "--porcelain"])).stdout.trim()).toBe("");
  });

  it("rejects outside staged and unstaged changes and leaves HEAD/index unchanged", async () => {
    const { root, manager } = await createRepo();
    const authorization = await manager.authorizeExactTrackedFileCommit("prompts/worker.md");
    const headBefore = authorization.head;

    // Outside unstaged change after authorization.
    await writeFile(path.join(root, "prompts", "worker.md"), "target change\n", "utf8");
    await writeFile(path.join(root, "README.md"), "outside unstaged\n", "utf8");
    await expect(
      manager.commitExactTrackedFile(authorization, "should fail unstaged"),
    ).rejects.toMatchObject({ code: "GIT_WORKTREE_CONTAMINATED" });
    expect((await git(root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(headBefore);
    expect((await git(root, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe("");

    // Reset worktree and try outside staged change.
    await git(root, ["checkout", "--", "README.md", "prompts/worker.md"]);
    const stagedAuthorization = await manager.authorizeExactTrackedFileCommit("prompts/worker.md");
    await writeFile(path.join(root, "prompts", "worker.md"), "target change\n", "utf8");
    await writeFile(path.join(root, "README.md"), "outside staged\n", "utf8");
    await git(root, ["add", "--", "README.md"]);
    await expect(
      manager.commitExactTrackedFile(stagedAuthorization, "should fail staged"),
    ).rejects.toMatchObject({ code: "GIT_WORKTREE_CONTAMINATED" });
    expect((await git(root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(headBefore);
    // Outside staged path remains staged; exact-path API must not create a commit.
    expect((await git(root, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe("README.md");
  });

  it("rejects HEAD drift, missing local changes, untracked targets, and invalid authorization", async () => {
    const { root, manager } = await createRepo();
    const emptyAuthorization = await manager.authorizeExactTrackedFileCommit("prompts/worker.md");

    // No local mutation after authorization.
    await expect(
      manager.commitExactTrackedFile(emptyAuthorization, "no changes"),
    ).rejects.toMatchObject({ code: "GIT_WORKTREE_CONTAMINATED" });

    // HEAD drift via an unrelated commit.
    const authorization = await manager.authorizeExactTrackedFileCommit("prompts/worker.md");
    await writeFile(path.join(root, "README.md"), "drift\n", "utf8");
    await git(root, ["add", "README.md"]);
    await git(root, ["commit", "-m", "unrelated"]);
    await writeFile(path.join(root, "prompts", "worker.md"), "after drift\n", "utf8");
    await expect(
      manager.commitExactTrackedFile(authorization, "after drift"),
    ).rejects.toMatchObject({ code: "GIT_HEAD_DRIFT" });

    // Restore a clean worktree before the next authorization.
    await git(root, ["checkout", "--", "prompts/worker.md"]);
    expect((await git(root, ["status", "--porcelain"])).stdout.trim()).toBe("");

    const cleanAuth = await manager.authorizeExactTrackedFileCommit("prompts/worker.md");
    await writeFile(path.join(root, "brand-new.md"), "new\n", "utf8");
    // A copied authorization is not manager-issued, even if every public field
    // names an existing tracked file.
    const forged: ExactTrackedFileCommitAuthorization = Object.freeze({
      ...cleanAuth,
    });
    await expect(manager.commitExactTrackedFile(forged, "forged")).rejects.toMatchObject({
      code: "GIT_INVALID_AUTHORIZATION",
    });
    expect((await git(root, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe("");
    expect((await git(root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(cleanAuth.head);

    await expect(
      manager.commitExactTrackedFile(
        {
          kind: "exact-tracked-file-commit",
          root: cleanAuth.root,
          head: "not-a-git-object",
          repositoryRelativePath: "prompts/worker.md",
          issuedAtMs: Date.now(),
        },
        "bad head",
      ),
    ).rejects.toMatchObject({ code: "GIT_INVALID_AUTHORIZATION" });

    await expect(
      manager.commitExactTrackedFile(
        {
          kind: "other" as ExactTrackedFileCommitAuthorization["kind"],
          root: cleanAuth.root,
          head: cleanAuth.head,
          repositoryRelativePath: "prompts/worker.md",
          issuedAtMs: Date.now(),
        },
        "bad kind",
      ),
    ).rejects.toMatchObject({ code: "GIT_INVALID_AUTHORIZATION" });

    await expect(
      manager.commitExactTrackedFile(cleanAuth, "   "),
    ).rejects.toMatchObject({ code: "GIT_INVALID_AUTHORIZATION" });
  });

  it("stages only the exact path using argv and never invokes a shell", async () => {
    const { root, manager } = await createRepo();
    const authorization = await manager.authorizeExactTrackedFileCommit("prompts/worker.md");
    await writeFile(path.join(root, "prompts", "worker.md"), "argv-safe content\n", "utf8");

    const processModule = await import("../src/process/run.js");
    const spy = vi.spyOn(processModule, "runProcess");
    try {
      await manager.commitExactTrackedFile(authorization, "argv only commit");
      const gitCalls = spy.mock.calls
        .map((call) => call[0])
        .filter((options) => options.command === "git");
      expect(gitCalls.length).toBeGreaterThan(0);
      for (const call of gitCalls) {
        expect(call.shell).toBeUndefined();
        expect(Array.isArray(call.args)).toBe(true);
      }
      const addCall = gitCalls.find(
        (call) => Array.isArray(call.args) && call.args[0] === "add",
      );
      expect(addCall?.args).toEqual(["add", "--", "prompts/worker.md"]);
      const commitTreeCall = gitCalls.find(
        (call) => Array.isArray(call.args) && call.args[0] === "commit-tree",
      );
      expect(commitTreeCall?.args?.[0]).toBe("commit-tree");
      const updateRefCall = gitCalls.find(
        (call) => Array.isArray(call.args) && call.args[0] === "update-ref",
      );
      expect(updateRefCall?.args?.slice(0, 4)).toEqual([
        "update-ref",
        "-m",
        "argv only commit",
        "refs/heads/main",
      ]);
    } finally {
      spy.mockRestore();
    }

    const show = await git(root, ["show", "--name-only", "--pretty=format:", "HEAD"]);
    expect(show.stdout.trim().split("\n").filter(Boolean)).toEqual(["prompts/worker.md"]);
  });

  it("handles NUL-delimited Unicode, whitespace, and arrow paths exactly", async () => {
    const { root, manager } = await createRepo();
    const specialPath = "prompts/角色 -> review name.md";
    await writeFile(path.join(root, specialPath), "initial\n", "utf8");
    await git(root, ["add", "--", specialPath]);
    await git(root, ["commit", "-m", "add special path"]);

    const authorization = await manager.authorizeExactTrackedFileCommit(specialPath);
    await writeFile(path.join(root, specialPath), "updated\n", "utf8");
    const result = await manager.commitExactTrackedFile(authorization, "update special path");

    expect(result.path).toBe(specialPath);
    expect(await manager.changedFiles(root)).toEqual([]);
    const shown = await git(root, ["show", "--name-only", "-z", "--pretty=format:", "HEAD"]);
    expect(shown.stdout.split("\0").filter(Boolean)).toEqual([specialPath]);
  });

  it("commits the verified staged blob when the target changes just before commit", async () => {
    const { root, manager } = await createRepo();
    const authorization = await manager.authorizeExactTrackedFileCommit("prompts/worker.md");
    const target = path.join(root, "prompts", "worker.md");
    await writeFile(target, "verified staged bytes\n", "utf8");

    const processModule = await import("../src/process/run.js");
    const originalRunProcess = processModule.runProcess;
    let statusCalls = 0;
    const spy = vi.spyOn(processModule, "runProcess").mockImplementation(async (options) => {
      const result = await originalRunProcess(options);
      if (
        options.command === "git" &&
        options.args?.[0] === "status" &&
        ++statusCalls === 2
      ) {
        await writeFile(target, "late working tree bytes\n", "utf8");
      }
      return result;
    });
    try {
      await manager.commitExactTrackedFile(authorization, "commit verified index");
    } finally {
      spy.mockRestore();
    }

    expect((await git(root, ["show", "HEAD:prompts/worker.md"])).stdout).toBe(
      "verified staged bytes\n",
    );
    expect(await readFile(target, "utf8")).toBe("late working tree bytes\n");
  });

  it.skipIf(process.platform === "win32")(
    "does not run pre-commit hooks that could add unverified paths",
    async () => {
      const { root, manager } = await createRepo();
      const hook = path.join(root, ".git", "hooks", "pre-commit");
      await writeFile(
        hook,
        "#!/bin/sh\nprintf 'hook mutation\\n' > README.md\ngit add -- README.md\n",
        "utf8",
      );
      await chmod(hook, 0o755);
      const authorization = await manager.authorizeExactTrackedFileCommit("prompts/worker.md");
      await writeFile(path.join(root, "prompts", "worker.md"), "authorized\n", "utf8");

      await manager.commitExactTrackedFile(authorization, "hook-safe commit");

      const shown = await git(root, ["show", "--name-only", "-z", "--pretty=format:", "HEAD"]);
      expect(shown.stdout.split("\0").filter(Boolean)).toEqual(["prompts/worker.md"]);
      expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("readme\n");
    },
  );
});

describe("GitManager commit subjects and worktree pruning", () => {
  it("maps first-parent commits to their subjects and prunes stale worktrees", async () => {
    const { root, manager } = await createRepo();
    const base = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(path.join(root, "README.md"), "readme two\n", "utf8");
    await git(root, ["commit", "-am", "second subject line"]);
    const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();

    const subjects = await manager.commitSubjects(root, base, "HEAD");
    expect(subjects.get(head)).toBe("second subject line");
    expect(subjects.size).toBe(1);

    // Prune is a safe no-op when there are no stale registrations.
    await manager.pruneWorktrees();
    const listed = (await git(root, ["worktree", "list"])).stdout.trim();
    expect(listed.split("\n")).toHaveLength(1);
  });
});

async function createRepo(): Promise<{ root: string; manager: GitManager }> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-git-exact-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await mkdir(path.join(root, "prompts"), { recursive: true });
  await writeFile(path.join(root, "prompts", "worker.md"), "original worker prompt\n", "utf8");
  await writeFile(path.join(root, "README.md"), "readme\n", "utf8");
  await git(root, ["add", "prompts/worker.md", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  const manager = new GitManager(root, path.join(root, ".agent-team", "worktrees"));
  return { root, manager };
}

async function git(root: string, args: string[]) {
  const result = await runProcess({ command: "git", args, cwd: root, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result;
}
