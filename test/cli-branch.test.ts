import { describe, expect, it } from "vitest";
import { runProcess } from "../src/process/run.js";

describe("agent-team branch CLI", () => {
  it("exposes list, create, and sync subcommands", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["--import", "tsx", "src/cli.ts", "branch", "--help"],
      cwd: process.cwd(),
      timeoutMs: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("list");
    expect(result.stdout).toContain("create");
    expect(result.stdout).toContain("sync");
    expect(result.stdout).toContain("ff-only");
  });
});
