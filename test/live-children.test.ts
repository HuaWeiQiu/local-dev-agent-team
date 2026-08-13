import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginLiveChild,
  isAgentCliCommand,
  reapOrphanAgentProcesses,
} from "../src/process/live-children.js";
import { resolveAgentTeamStateRoot } from "../src/process/state-root.js";
import { runProcess } from "../src/process/run.js";

const children: Array<ReturnType<typeof spawn>> = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }
});

describe("live child ledger", () => {
  it("records a spawned pid and forgets it after the process exits", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "agent-team-live-"));
    const handle = beginLiveChild(stateRoot, {
      command: process.execPath,
      cwd: stateRoot,
      runId: "run-1",
    });
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: stateRoot,
      timeoutMs: 5_000,
      liveChild: handle,
    });
    expect(result.exitCode).toBe(0);
    await handle.release();
    expect(await readdir(path.join(stateRoot, "live-children")).catch(() => [])).toEqual([]);
  });

  it("reaps a leftover ledger pid after a simulated crash", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-reap-"));
    const stateRoot = path.join(root, ".agent-team");
    const worktreesRoot = path.join(stateRoot, "worktrees");
    const fakeCli = await writeLoopingCli(root, "codex");
    const child = spawn(fakeCli, [], {
      cwd: root,
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    children.push(child);
    expect(child.pid).toBeTypeOf("number");
    const handle = beginLiveChild(stateRoot, { command: fakeCli, cwd: root });
    await handle.attach(child.pid!);
    const names = await readdir(path.join(stateRoot, "live-children"));
    expect(names).toEqual([`${child.pid}.json`]);

    const reaped = await reapOrphanAgentProcesses({ stateRoot, worktreesRoot });
    expect(reaped.killed).toContain(child.pid);
    await waitUntilGone(child.pid!);
    expect(await readdir(path.join(stateRoot, "live-children"))).toEqual([]);
  });

  it("never kills a planted ledger record that has no startToken", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-planted-"));
    const stateRoot = path.join(root, ".agent-team");
    const worktreesRoot = path.join(stateRoot, "worktrees");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: root,
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    children.push(child);
    expect(child.pid).toBeTypeOf("number");
    // An untrusted repository can commit arbitrary ledger files. A record
    // without a matching startToken proves nothing about who spawned the
    // process, so it must be discarded instead of killed.
    await mkdir(path.join(stateRoot, "live-children"), { recursive: true });
    await writeFile(
      path.join(stateRoot, "live-children", `${child.pid}.json`),
      `${JSON.stringify({ pid: child.pid, command: "/bin/sh", cwd: root })}\n`,
    );

    const reaped = await reapOrphanAgentProcesses({ stateRoot, worktreesRoot });
    expect(reaped.killed).toEqual([]);
    expect(await readdir(path.join(stateRoot, "live-children"))).toEqual([]);
    expect(isAlive(child.pid!)).toBe(true);
  });

  it("never kills a ledger record whose startToken does not match the live process", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-mismatch-"));
    const stateRoot = path.join(root, ".agent-team");
    const worktreesRoot = path.join(stateRoot, "worktrees");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: root,
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    children.push(child);
    expect(child.pid).toBeTypeOf("number");
    await mkdir(path.join(stateRoot, "live-children"), { recursive: true });
    await writeFile(
      path.join(stateRoot, "live-children", `${child.pid}.json`),
      `${JSON.stringify({
        pid: child.pid,
        command: "/opt/homebrew/bin/grok",
        cwd: root,
        startToken: "forged-start-token",
      })}\n`,
    );

    const reaped = await reapOrphanAgentProcesses({ stateRoot, worktreesRoot });
    expect(reaped.killed).toEqual([]);
    expect(isAlive(child.pid!)).toBe(true);
  });

  it("never kills a ledger record whose command is not an agent CLI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-command-"));
    const stateRoot = path.join(root, ".agent-team");
    const worktreesRoot = path.join(stateRoot, "worktrees");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: root,
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    children.push(child);
    expect(child.pid).toBeTypeOf("number");
    const handle = beginLiveChild(stateRoot, { command: process.execPath, cwd: root });
    await handle.attach(child.pid!);
    // Rewrite the command field to something that is not an agent CLI while
    // keeping the genuine startToken: identity alone is not enough.
    const recordPath = path.join(stateRoot, "live-children", `${child.pid}.json`);
    const planted = JSON.parse(await readFile(recordPath, "utf8"));
    planted.command = "/usr/bin/git";
    await writeFile(recordPath, `${JSON.stringify(planted)}\n`);

    const reaped = await reapOrphanAgentProcesses({ stateRoot, worktreesRoot });
    expect(reaped.killed).toEqual([]);
    expect(isAlive(child.pid!)).toBe(true);
  });

  it("never kills a ledger record whose cwd leaves the project root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-cwd-"));
    const stateRoot = path.join(root, ".agent-team");
    const worktreesRoot = path.join(stateRoot, "worktrees");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: root,
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    children.push(child);
    expect(child.pid).toBeTypeOf("number");
    const handle = beginLiveChild(stateRoot, { command: process.execPath, cwd: root });
    await handle.attach(child.pid!);
    const recordPath = path.join(stateRoot, "live-children", `${child.pid}.json`);
    const planted = JSON.parse(await readFile(recordPath, "utf8"));
    planted.command = "/opt/homebrew/bin/grok";
    planted.cwd = "/tmp";
    await writeFile(recordPath, `${JSON.stringify(planted)}\n`);

    const reaped = await reapOrphanAgentProcesses({ stateRoot, worktreesRoot });
    expect(reaped.killed).toEqual([]);
    expect(isAlive(child.pid!)).toBe(true);
  });

  it("scans leftover agent CLIs still sitting in a managed worktree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-scan-"));
    const stateRoot = path.join(root, ".agent-team");
    const worktreesRoot = path.join(stateRoot, "worktrees");
    const worktree = path.join(worktreesRoot, "run-1", "t1");
    await mkdir(worktree, { recursive: true });
    const fakeCli = await writeLoopingCli(root, "grok");
    const child = spawn(fakeCli, ["--cwd", worktree], {
      cwd: worktree,
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    children.push(child);
    expect(child.pid).toBeTypeOf("number");
    await waitUntilListed(child.pid!);

    const reaped = await reapOrphanAgentProcesses({ stateRoot, worktreesRoot });
    expect(reaped.killed).toContain(child.pid);
    await waitUntilGone(child.pid!);
  });

  it("recognizes managed agent CLI names and worktree state roots", () => {
    expect(isAgentCliCommand("/opt/homebrew/bin/grok --cwd /tmp/x")).toBe(true);
    expect(isAgentCliCommand("codex exec --json")).toBe(true);
    expect(isAgentCliCommand("/usr/bin/git status")).toBe(false);
    expect(
      resolveAgentTeamStateRoot(
        "/Users/tanye/cinevfx/.agent-team/worktrees/run/t1-resume-1",
      ),
    ).toBe("/Users/tanye/cinevfx/.agent-team");
  });
});

async function waitUntilGone(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      return;
    }
  }
  throw new Error(`pid ${pid} still alive`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeLoopingCli(root: string, name: string): Promise<string> {
  const cli = path.join(root, name);
  await writeFile(cli, "#!/bin/sh\nwhile true; do sleep 1; done\n", { mode: 0o755 });
  return cli;
}

async function waitUntilListed(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`pid ${pid} never appeared`);
}
