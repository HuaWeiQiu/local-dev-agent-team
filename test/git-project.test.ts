import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GitActionError,
  GitProjectService,
  isTemporaryAgentBranch,
  suggestBranchName,
} from "../src/git/project.js";
import { runProcess } from "../src/process/run.js";

const probeGithub = async () => ({ installed: true, authenticated: true, repoAccess: true });

describe("GitProjectService", () => {
  it("reports repository, branch, and GitHub capability status", async () => {
    const { root, service } = await createRemoteRepo("status");
    const status = await service.status();

    expect(status.gitInstalled).toBe(true);
    expect(status.isRepository).toBe(true);
    expect(status.repoRootMatches).toBe(true);
    expect(status.worktreeClean).toBe(true);
    expect(status.hasCommits).toBe(true);
    expect(status.currentBranch).toBe("main");
    expect(status.remoteDefaultBranch).toBe("main");
    expect(status.defaultBranchSource).toBe("git");
    expect(status.ghAuthenticated).toBe(true);
    expect(status.canSync).toBe(true);
    expect(status.canPublish).toBe(true);
    expect(status.blockers).toEqual([]);
    expect(status.dirtyFiles).toEqual([]);
  });

  it("summarizes Changes and commits only the selected path", async () => {
    const { root, service } = await createRemoteRepo("changes-commit");
    await writeFile(path.join(root, "keep.txt"), "keep\n");
    await writeFile(path.join(root, "notes.txt"), "one\ntwo\n");
    const changes = await service.changes();
    expect(changes.files.map((file) => file.path).sort()).toEqual(["keep.txt", "notes.txt"]);
    expect(changes.insertions).toBeGreaterThan(0);
    expect(changes.canCommit).toBe(true);

    const committed = await service.commitPaths({
      message: "chore: keep only notes",
      paths: ["notes.txt"],
    });
    expect(committed.files).toEqual(["notes.txt"]);
    const after = await service.status();
    expect(after.dirtyFiles.map((file) => file.path)).toEqual(["keep.txt"]);
    expect(after.changeSummary?.files).toBe(1);
  });

  it("rejects path escape on commit and refuses to push when behind", async () => {
    const { root, remote, service } = await createRemoteRepo("commit-guard");
    await writeFile(path.join(root, "notes.txt"), "local\n");
    await expect(service.commitPaths({
      message: "bad",
      paths: ["../outside.txt"],
    })).rejects.toMatchObject({ code: "invalid-name" });

    await service.commitPaths({ message: "local notes", paths: ["notes.txt"] });
    const peer = path.join(tmpdir(), `agent-team-peer-behind-${Date.now()}`);
    await gitOut(path.dirname(peer), ["clone", remote, peer]);
    await writeFile(path.join(peer, "peer.txt"), "peer\n");
    await git(peer, ["add", "."]);
    await git(peer, ["commit", "-m", "peer"]);
    await git(peer, ["push", "origin", "main"]);
    await git(root, ["fetch", "origin"]);

    await expect(service.pushCurrentBranch()).rejects.toMatchObject({ code: "behind-remote" });
  });

  it("lists dirty files and can stash the primary worktree", async () => {
    const { root, service } = await createRemoteRepo("dirty-stash");
    await writeFile(path.join(root, "notes.txt"), "local edit\n");
    const dirty = await service.status();
    expect(dirty.worktreeClean).toBe(false);
    expect(dirty.canSync).toBe(false);
    expect(dirty.dirtyFiles.some((file) => file.path === "notes.txt" && file.origin === "user")).toBe(true);
    expect(dirty.dirtyReason).toContain("未提交");

    const stashed = await service.stashWorktree();
    expect(stashed.created).toBe(true);
    const clean = await service.status();
    expect(clean.worktreeClean).toBe(true);
    expect(clean.dirtyFiles).toEqual([]);
  });

  it("reports a remote-not-allowed blocker when origin is outside the allowlist", async () => {
    const { service } = await createRemoteRepo("allowlist", { allowedOwners: ["acme"] });
    const status = await service.status();
    expect(status.remoteAllowed).toBe(false);
    expect(status.blockers).toContain("remote-not-allowed");
  });

  it("lists local and remote branches with default/current markers", async () => {
    const { root, service } = await createRemoteRepo("list");
    await git(root, ["branch", "feature/local"]);
    const branches = await service.branches("all");

    expect(branches).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "main", kind: "local", isDefault: true, isCurrent: true }),
      expect.objectContaining({ name: "main", kind: "remote", isDefault: true }),
      expect.objectContaining({ name: "feature/local", kind: "local" }),
    ]));
  });

  it("syncs a checked-out branch with fetch + fast-forward only", async () => {
    const { root, remote, service, initial } = await createRemoteRepo("sync-ff");
    const peer = path.join(tmpdir(), `agent-team-peer-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await gitOut(path.dirname(peer), ["clone", remote, peer]);
    await writeFile(path.join(peer, "peer.txt"), "peer\n");
    await git(peer, ["add", "."]);
    await git(peer, ["commit", "-m", "peer commit"]);
    await git(peer, ["push", "origin", "main"]);
    const remoteHead = (await gitOut(peer, ["rev-parse", "HEAD"])).stdout.trim();

    const result = await service.sync();
    expect(result).toEqual({
      branch: "main",
      previousCommit: initial,
      newCommit: remoteHead,
      changed: true,
    });
    expect((await gitOut(root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(remoteHead);
    expect(await gitOut(root, ["status", "--porcelain"]).then((value) => value.stdout)).toBe("");
  });

  it("creates a missing local default branch from the remote during sync", async () => {
    const { root, service } = await createRemoteRepo("sync-missing");
    await git(root, ["checkout", "--detach"]);
    await git(root, ["update-ref", "-d", "refs/heads/main"]);
    const status = await service.status();
    expect(status.localDefaultBranch).toBeUndefined();

    const result = await service.sync();
    expect(result.changed).toBe(true);
    expect(result.previousCommit).toBeUndefined();
    expect((await gitOut(root, ["rev-parse", "refs/heads/main"])).stdout.trim()).toBe(result.newCommit);
  });

  it("rejects a non-fast-forward sync without touching local refs", async () => {
    const { root, remote, service } = await createRemoteRepo("sync-diverged");
    const peer = path.join(tmpdir(), `agent-team-peer-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await gitOut(path.dirname(peer), ["clone", remote, peer]);
    await writeFile(path.join(peer, "peer.txt"), "peer\n");
    await git(peer, ["add", "."]);
    await git(peer, ["commit", "-m", "peer commit"]);
    await git(peer, ["push", "origin", "main"]);

    await writeFile(path.join(root, "local.txt"), "local\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "local commit"]);
    const localHead = (await gitOut(root, ["rev-parse", "HEAD"])).stdout.trim();

    await expect(service.sync()).rejects.toMatchObject({ code: "non-fast-forward" });
    expect((await gitOut(root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(localHead);
  });

  it("creates a branch from the synced default branch when syncFirst is set", async () => {
    const { root, remote, service, initial } = await createRemoteRepo("create-synced");
    const peer = path.join(tmpdir(), `agent-team-peer-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await gitOut(path.dirname(peer), ["clone", remote, peer]);
    await writeFile(path.join(peer, "peer.txt"), "peer\n");
    await git(peer, ["add", "."]);
    await git(peer, ["commit", "-m", "peer commit"]);
    await git(peer, ["push", "origin", "main"]);
    const remoteHead = (await gitOut(peer, ["rev-parse", "HEAD"])).stdout.trim();
    expect(remoteHead).not.toBe(initial);

    const branch = await service.create({ name: "feature/goal-slug", syncFirst: true });
    expect(branch.commit).toBe(remoteHead);
    expect((await gitOut(root, ["rev-parse", "refs/heads/feature/goal-slug"])).stdout.trim()).toBe(remoteHead);
  });

  it("rejects invalid, reserved, or conflicting branch names", async () => {
    const { root, service } = await createRemoteRepo("invalid-names");
    await git(root, ["branch", "feature/existing"]);

    await expect(service.create({ name: "agent-team/secret" })).rejects.toMatchObject({ code: "invalid-name" });
    await expect(service.create({ name: "bad..name" })).rejects.toMatchObject({ code: "invalid-name" });
    await expect(service.create({ name: "feature/existing" })).rejects.toMatchObject({ code: "branch-exists" });
  });

  it("preflights head branch availability for the workflow runner", async () => {
    const { root, service } = await createRemoteRepo("head-available");
    await git(root, ["branch", "feature/used"]);
    await expect(service.assertHeadBranchAvailable("feature/fresh")).resolves.toBeUndefined();
    await expect(service.assertHeadBranchAvailable("feature/used")).rejects.toMatchObject({ code: "branch-exists" });
  });

  it("initializes a repository and creates an empty initial commit on demand", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-empty-repo-"));
    const service = new GitProjectService({
      root,
      worktreesRoot: path.join(root, ".agent-team", "worktrees"),
      remote: "origin",
      configDefaultBranch: "main",
      probeGithub,
    });

    await expect(service.initializeRepository()).resolves.toEqual({ initialized: true });
    await expect(service.initializeRepository()).resolves.toEqual({ initialized: false });
    const status = await service.status();
    expect(status.isRepository).toBe(true);
    expect(status.hasCommits).toBe(false);

    const commit = await service.createInitialCommit();
    expect(commit).toBe((await gitOut(root, ["rev-parse", "HEAD"])).stdout.trim());
    expect((await service.status()).hasCommits).toBe(true);
  });

  it("marks and deletes only unused agent-team temporary branches", async () => {
    const { root, service } = await createRemoteRepo("temp-branches");
    await git(root, ["branch", "agent-team/old-run/integration"]);
    await git(root, ["branch", "feature/keep-me"]);
    const listed = await service.branches("local");
    expect(listed.find((branch) => branch.name === "agent-team/old-run/integration")?.temporary).toBe(true);
    expect(listed.find((branch) => branch.name === "feature/keep-me")?.temporary).toBeFalsy();
    expect(listed.find((branch) => branch.name === "main")?.temporary).toBeFalsy();

    const cleaned = await service.deleteTemporaryBranches();
    expect(cleaned.deleted).toContain("agent-team/old-run/integration");
    const after = await service.branches("local");
    expect(after.some((branch) => branch.name === "feature/keep-me")).toBe(true);
    expect(after.some((branch) => branch.name === "agent-team/old-run/integration")).toBe(false);
  });
});

describe("isTemporaryAgentBranch", () => {
  it("never treats the current or default branch as temporary", () => {
    expect(isTemporaryAgentBranch("agent-team/foo")).toBe(true);
    expect(isTemporaryAgentBranch("agent-team/foo", "agent-team/foo")).toBe(false);
    expect(isTemporaryAgentBranch("main")).toBe(false);
    expect(isTemporaryAgentBranch("feature/keep")).toBe(false);
  });
});

describe("suggestBranchName", () => {
  it("derives a collision-safe feature branch name from the goal", () => {
    expect(suggestBranchName("  Add cursor pagination to user list! ")).toBe(
      "feature/add-cursor-pagination-to-user-list",
    );
    expect(suggestBranchName("fix login", "feature", ["feature/fix-login"])).toBe("feature/fix-login-2");
  });
});

async function createRemoteRepo(
  name: string,
  options: { allowedOwners?: string[] } = {},
): Promise<{
  root: string;
  remote: string;
  service: GitProjectService;
  initial: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), `agent-team-${name}-`));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Agent Team Test"]);
  await git(root, ["config", "user.email", "agent-team@example.com"]);
  await writeFile(path.join(root, "README.md"), "# Fixture\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  const initial = (await gitOut(root, ["rev-parse", "HEAD"])).stdout.trim();

  const remote = path.join(tmpdir(), `agent-team-${name}-${path.basename(root)}-remote.git`);
  await mkdir(remote, { recursive: true });
  await gitOut(remote, ["init", "--bare"]);
  await git(root, ["remote", "add", "origin", remote]);
  await git(root, ["push", "-u", "origin", "main"]);

  const service = new GitProjectService({
    root,
    worktreesRoot: path.join(root, ".agent-team", "worktrees"),
    remote: "origin",
    configDefaultBranch: "main",
    ...(options.allowedOwners ? { allowedOwners: options.allowedOwners } : {}),
    probeGithub,
  });
  return { root, remote, service, initial };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await gitOut(cwd, args);
}

async function gitOut(cwd: string, args: string[]) {
  const result = await runProcess({ command: "git", args, cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return result;
}
