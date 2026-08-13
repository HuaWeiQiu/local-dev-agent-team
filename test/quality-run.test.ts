import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureWorktreeNodeModules } from "../src/quality/install.js";
import { runQualityCommands } from "../src/quality/run.js";

describe("runQualityCommands", () => {
  it("runs every command and passes when all exit zero", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agent-team-quality-"));
    const artifactDirectory = path.join(cwd, "artifacts");

    const report = await runQualityCommands(
      cwd,
      [
        { command: process.execPath, args: ["-e", "console.log('one')"] },
        { command: process.execPath, args: ["-e", "console.log('two')"] },
      ],
      30,
      artifactDirectory,
    );

    expect(report.passed).toBe(true);
    expect(report.commands).toHaveLength(2);
    expect(report.commands[0]).toMatchObject({ exitCode: 0, stdout: "one\n", timedOut: false });
    expect(report.commands[1]).toMatchObject({ exitCode: 0, stdout: "two\n" });
    const log = await readFile(path.join(artifactDirectory, "1.log"), "utf8");
    expect(log).toContain("exit: 0");
    expect(log).toContain("one");
  });

  it("stops before the next command once one exits non-zero", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agent-team-quality-fail-"));
    const marker = path.join(cwd, "marker.txt");

    const report = await runQualityCommands(
      cwd,
      [
        { command: process.execPath, args: ["-e", "process.exit(3)"] },
        {
          command: process.execPath,
          args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
        },
      ],
      30,
    );

    expect(report.passed).toBe(false);
    expect(report.commands).toHaveLength(1);
    expect(report.commands[0]?.exitCode).toBe(3);
    // The second command never ran.
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });

  it("synthesizes a failed result when the executable cannot be spawned", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agent-team-quality-enoent-"));

    const report = await runQualityCommands(
      cwd,
      [
        { command: "agent-team-no-such-executable", args: [] },
        { command: process.execPath, args: ["-e", "console.log('never')"] },
      ],
      30,
    );

    expect(report.passed).toBe(false);
    expect(report.commands).toHaveLength(1);
    expect(report.commands[0]).toMatchObject({ exitCode: null, timedOut: false, stdout: "" });
    expect(report.commands[0]?.stderr).toContain("ENOENT");
  });

  it("marks timed-out commands and fails the report", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agent-team-quality-timeout-"));

    const report = await runQualityCommands(
      cwd,
      [{ command: process.execPath, args: ["-e", "setTimeout(() => {}, 30_000)"] }],
      1,
    );

    expect(report.passed).toBe(false);
    expect(report.commands[0]).toMatchObject({ exitCode: null, timedOut: true });
  }, 15_000);

  it("rejects instead of recording results once the abort signal fires", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agent-team-quality-abort-"));
    const controller = new AbortController();
    controller.abort(new Error("deadline exceeded"));

    await expect(
      runQualityCommands(
        cwd,
        [{ command: process.execPath, args: ["-e", "console.log('late')"] }],
        30,
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow("deadline exceeded");
  });
});

describe("ensureWorktreeNodeModules", () => {
  it("skips when package.json is absent or node_modules already exists", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "agent-team-install-empty-"));
    expect(await ensureWorktreeNodeModules(empty, { timeoutSeconds: 5 })).toBeUndefined();

    const ready = await mkdtemp(path.join(tmpdir(), "agent-team-install-ready-"));
    await writeFile(path.join(ready, "package.json"), "{}\n");
    await writeFile(path.join(ready, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await mkdir(path.join(ready, "node_modules"));
    expect(await ensureWorktreeNodeModules(ready, { timeoutSeconds: 5 })).toBeUndefined();
  });

  it("skips install when package.json has no lockfile", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agent-team-install-nolock-"));
    await writeFile(path.join(cwd, "package.json"), "{}\n");
    const marker = path.join(cwd, "installed.txt");
    expect(
      await ensureWorktreeNodeModules(cwd, {
        timeoutSeconds: 10,
        installer: {
          command: process.execPath,
          args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`],
        },
      }),
    ).toBeUndefined();
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });

  it("runs the installer when package.json exists without node_modules", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agent-team-install-run-"));
    await writeFile(path.join(cwd, "package.json"), "{}\n");
    await writeFile(path.join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const marker = path.join(cwd, "installed.txt");
    const result = await ensureWorktreeNodeModules(cwd, {
      timeoutSeconds: 10,
      installer: {
        command: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`],
      },
    });
    expect(result?.exitCode).toBe(0);
    expect(await readFile(marker, "utf8")).toBe("ok");
  });

  it("fails loudly when the installer exits non-zero", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agent-team-install-fail-"));
    await writeFile(path.join(cwd, "package.json"), "{}\n");
    await writeFile(path.join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await expect(
      ensureWorktreeNodeModules(cwd, {
        timeoutSeconds: 10,
        installer: { command: process.execPath, args: ["-e", "process.exit(2)"] },
      }),
    ).rejects.toThrow(/node_modules missing/);
  });
});
