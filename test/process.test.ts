import { describe, expect, it } from "vitest";
import { runProcess } from "../src/process/run.js";

describe("managed processes", () => {
  it("streams output and terminates an aborted process", async () => {
    const controller = new AbortController();
    const stdout: string[] = [];
    const running = runProcess({
      command: process.execPath,
      args: [
        "-e",
        "console.log('ready'); setInterval(() => console.log('tick'), 50)",
      ],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      signal: controller.signal,
      onStdout: (chunk) => {
        stdout.push(chunk);
        if (chunk.includes("ready")) {
          controller.abort(new Error("test cancellation"));
        }
      },
    });

    const result = await running;
    expect(stdout.join("")).toContain("ready");
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it("rejects before spawn when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await expect(
      runProcess({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
        timeoutMs: 1_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow("already cancelled");
  });

  it("rejects a missing executable without waiting for its timeout", async () => {
    const startedAt = Date.now();
    await expect(
      runProcess({
        command: `missing-agent-team-command-${Date.now()}`,
        args: [],
        cwd: process.cwd(),
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("caps captured and streamed output without blocking the child", async () => {
    const streamed: string[] = [];
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('abcdefghij')"],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      maxOutputBytes: 4,
      onStdout: (chunk) => streamed.push(chunk),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("abcd");
    expect(streamed.join("")).toBe("abcd");
    expect(result.stdoutBytes).toBe(4);
    expect(result.stdoutTruncated).toBe(true);
  });
});
