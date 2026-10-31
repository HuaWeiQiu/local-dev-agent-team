import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, resolveUb, toolArgs } from "../scripts/ub-quality-gate.mjs";

const script = path.resolve("scripts/ub-quality-gate.mjs");

async function stubTool(body: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-ub-gate-"));
  const file = path.join(root, "ub");
  await writeFile(file, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(file, 0o755);
  return file;
}

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("ub quality gate wrapper", () => {
  it("defaults to a changed-files crapper ratchet", () => {
    const options = parseArgs([], {});
    expect(options).toEqual({
      tool: "crapper",
      threshold: "10",
      changed: true,
      ub: "",
      extra: [],
    });
    expect(toolArgs(options)).toEqual(["crapper", "--changed", "--threshold", "10"]);
  });

  it("parses tool, threshold, scope and passthrough arguments", () => {
    const options = parseArgs(
      ["--tool", "mutator", "--threshold", "4", "--all", "--ub", "/tmp/ub", "--", "--scan", "src"],
      {},
    );
    expect(options.tool).toBe("mutator");
    expect(options.threshold).toBe("4");
    expect(options.changed).toBe(false);
    expect(options.extra).toEqual(["--scan", "src"]);
    expect(toolArgs(options)).toEqual(["mutator", "--scan", "src"]);

    const dryer = parseArgs(["--tool", "dryer", "--threshold", "0.9"], {});
    expect(toolArgs(dryer)).toEqual(["dryer", "--threshold", "0.9"]);
  });

  it("rejects unknown arguments and missing tool chain paths", () => {
    expect(() => parseArgs(["--wat"], {})).toThrow(/unknown argument '--wat'/);
    expect(() => parseArgs(["--threshold"], {})).toThrow(/requires a value/);
    expect(resolveUb("/definitely/not/installed/ub", {})).toBeUndefined();
  });

  it("forwards the ratchet arguments and passes the tool exit code through", async () => {
    const log = path.join(await mkdtemp(path.join(tmpdir(), "agent-team-ub-log-")), "args.txt");
    const ub = await stubTool(`printf '%s\\n' "$@" > ${log}\nexit 2`);

    const result = run(["--ub", ub, "--threshold", "12"]);
    expect(result.status).toBe(2);

    const forwarded = (await readFile(log, "utf8")).trim().split("\n");
    expect(forwarded).toEqual(["crapper", "--changed", "--threshold", "12"]);
  });

  it("scans the whole project when --all is given", async () => {
    const log = path.join(await mkdtemp(path.join(tmpdir(), "agent-team-ub-log-")), "args.txt");
    const ub = await stubTool(`printf '%s\\n' "$@" > ${log}\nexit 0`);

    const result = run(["--ub", ub, "--all"]);
    expect(result.status).toBe(0);
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "crapper",
      "--threshold",
      "10",
    ]);
  });

  it("fails with exit code 3 when the tool chain is missing", () => {
    const result = run(["--ub", "/definitely/not/installed/ub"], {
      UB_BIN: "",
    });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("ub-mode tool chain not found");
  });

  it("rejects unknown tools instead of running something else", async () => {
    const ub = await stubTool("exit 0");
    const result = run(["--ub", ub, "--tool", "lint"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--tool must be crapper, dryer or mutator");
  });
});
