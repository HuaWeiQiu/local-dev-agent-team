import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  main,
  parseArgs,
  readBaseline,
  baselineStep,
  isScoredSource,
  layerTargets,
  layers,
  readScores,
  regressions,
  resolveUb,
  toolArgs,
} from "../scripts/ub-quality-gate.mjs";

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
      rustThreshold: "20",
      changed: true,
      baseline: ".ub-crap-baseline.json",
      updateBaseline: false,
      ub: "",
      extra: [],
    });
    // Changed mode analyzes exactly the changed files, per layer.
    expect(toolArgs(options, "typescript", [])).toBeUndefined();
    expect(toolArgs(options, "typescript", ["web/src/App.tsx"])).toEqual([
      "crapper",
      "web/src/App.tsx",
      "--threshold",
      "10",
    ]);
    expect(toolArgs(options, "rust", ["src-tauri/src/lib.rs", "web/src/App.tsx"])).toEqual([
      "crapper",
      "src-tauri/src/lib.rs",
      "--no-coverage",
      "--threshold",
      "20",
    ]);
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
    expect(toolArgs(options)).toEqual(["mutator", "--threshold", "4", "--scan", "src"]);

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

    // `--all` keeps the assertion independent of the checkout's git state.
    const result = run(["--ub", ub, "--threshold", "12", "--all"]);
    expect(result.status).toBe(2);

    // The stub logs its last call: the TypeScript layer (Rust runs first).
    // Only the TypeScript layer has a changed file in this repository state.
    const forwarded = (await readFile(log, "utf8")).trim().split("\n");
    expect(forwarded[0]).toBe("crapper");
    expect(forwarded.slice(0, 4)).toEqual(["crapper", "src", "web", "scripts"]);
    expect(forwarded).toContain("12");
  });

  it("scans the whole project when --all is given", async () => {
    const log = path.join(await mkdtemp(path.join(tmpdir(), "agent-team-ub-log-")), "args.txt");
    const ub = await stubTool(`printf '%s\\n' "$@" > ${log}\nexit 0`);

    // A missing baseline keeps this test about the arguments, not about debt.
    const baseline = path.join(await mkdtemp(path.join(tmpdir(), "agent-team-nobase-")), "base.json");
    const result = run(["--ub", ub, "--all", "--baseline", baseline]);
    expect(result.status).toBe(0);
    const forwarded = (await readFile(log, "utf8")).trim().split("\n");
    expect(forwarded[0]).toBe("crapper");
    expect(forwarded).not.toContain("--changed");
    expect(forwarded).toContain("--threshold");
    expect(layers(parseArgs([], {}))).toEqual(["rust", "typescript"]);
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

describe("gate layering and baseline", () => {
  it("scores the Rust crate with its own complexity-only threshold", () => {
    const options = parseArgs([], {});
    expect(toolArgs(options, "rust", ["src-tauri/src/lib.rs"])).toEqual([
      "crapper",
      "src-tauri/src/lib.rs",
      "--no-coverage",
      "--threshold",
      "20",
    ]);
    const custom = parseArgs(["--rust-threshold", "8"], {});
    expect(custom.rustThreshold).toBe("8");
    expect(toolArgs(custom, "rust", ["src-tauri/src/lib.rs"])).toContain("8");
  });

  it("reads scores from the EDN crapper writes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-crap-"));
    const metrics = path.join(root, "crap.edn");
    await writeFile(
      metrics,
      [
        '{:name "big", :namespace "a.b", :complexity 12, :coverage 0.0, :crap 156.0}',
        '{:name "small", :namespace "a.b", :complexity 2, :coverage 100.0, :crap 2.0}',
      ].join("\n"),
      "utf8",
    );
    const scores = readScores(metrics);
    expect(scores.get("a.b#big")).toBe(156);
    expect(scores.get("a.b#small")).toBe(2);
    expect(readScores(path.join(root, "missing.edn")).size).toBe(0);
  });

  it("reports only functions worse than the frozen baseline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-baseline-"));
    const baselinePath = path.join(root, "baseline.json");
    await writeFile(
      baselinePath,
      JSON.stringify({ scores: { "a.b#big": 100, "a.b#frozen": 300 } }),
      "utf8",
    );
    const baseline = readBaseline(baselinePath);
    expect(baseline).toBeDefined();

    const scores = new Map([
      ["a.b#big", 156],
      ["a.b#frozen", 300],
      ["a.b#new", 120],
      ["a.b#tiny", 4],
    ]);
    const worse = regressions(scores, baseline);
    expect(worse.map((entry) => entry.key)).toEqual(["a.b#big", "a.b#new"]);
    expect(readBaseline(path.join(root, "nope.json"))).toBeUndefined();
  });
});

describe("gate main", () => {
  it("prints help without running the tool", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(main(["--help"])).toBe(0);
    expect(write).toHaveBeenCalledWith(expect.stringContaining("usage:"));
    write.mockRestore();
  });

  it("runs the tool in-process and returns its status", async () => {
    const passing = await stubTool("exit 0");
    expect(main(["--ub", passing, "--tool", "dryer", "--threshold", "0.8"])).toBe(0);
    const failing = await stubTool("exit 2");
    expect(main(["--ub", failing, "--tool", "dryer"])).toBe(2);
    const broken = await stubTool("exit 1");
    expect(main(["--ub", broken, "--tool", "dryer"])).toBe(1);
  });

  it("reports a bad argument and a missing tool chain", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(main(["--wat"])).toBe(1);
    expect(main(["--ub", "/definitely/not/installed/ub"])).toBe(3);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("unknown argument"));
    stderr.mockRestore();
  });
});

describe("baseline step", () => {
  async function workdir(scores: string[], baseline?: Record<string, number>) {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-baseline-step-"));
    await mkdir(path.join(root, ".metrics"), { recursive: true });
    if (scores.length > 0) {
      await writeFile(path.join(root, ".metrics", "crap.edn"), scores.join("\n"), "utf8");
    }
    if (baseline) {
      await writeFile(path.join(root, "base.json"), JSON.stringify({ scores: baseline }), "utf8");
    }
    return root;
  }

  it("writes a baseline of everything over the threshold", async () => {
    const root = await workdir([
      '{:name "big", :namespace "a", :complexity 12, :coverage 0.0, :crap 156.0}',
      '{:name "tiny", :namespace "a", :complexity 1, :coverage 100.0, :crap 1.0}',
    ]);
    const options = { ...parseArgs(["--update-baseline", "--baseline", "base.json"], {}), baseline: "base.json" };
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(baselineStep(options, root)).toBe(0);
    const written = JSON.parse(await readFile(path.join(root, "base.json"), "utf8"));
    expect(Object.keys(written.scores)).toEqual(["a#big"]);
    stdout.mockRestore();
  });

  it("fails only when a function got worse than its frozen score", async () => {
    const scores = ['{:name "big", :namespace "a", :complexity 12, :coverage 0.0, :crap 156.0}'];
    const worseRoot = await workdir(scores, { "a#big": 100 });
    const sameRoot = await workdir(scores, { "a#big": 156 });
    const options = { ...parseArgs(["--baseline", "base.json"], {}), baseline: "base.json" };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(baselineStep(options, worseRoot)).toBe(2);
    expect(baselineStep(options, sameRoot)).toBe(0);
    stderr.mockRestore();
  });

  it("does nothing without a baseline file or for other tools", async () => {
    const root = await workdir([]);
    expect(baselineStep({ ...parseArgs([], {}), baseline: "missing.json" }, root)).toBe(0);
    expect(baselineStep({ ...parseArgs(["--tool", "dryer"], {}) }, root)).toBe(0);
  });
});

describe("layer targets", () => {
  it("partitions the changed files by extension owner", () => {
    const options = parseArgs([], {});
    const changed = ["web/src/App.tsx", "src-tauri/src/lib.rs", "scripts/ub-quality-gate.mjs"];
    expect(layerTargets(options, "rust", changed)).toEqual(["src-tauri/src/lib.rs"]);
    expect(layerTargets(options, "typescript", changed)).toEqual([
      "web/src/App.tsx",
      "scripts/ub-quality-gate.mjs",
    ]);
    const all = parseArgs(["--all"], {});
    expect(layerTargets(all, "rust", [])).toEqual(["src-tauri"]);
    expect(layerTargets(all, "typescript", [])).toEqual(["src", "web", "scripts"]);
  });
});

describe("scored sources", () => {
  it("keeps test and e2e files out of the changed list", () => {
    expect(isScoredSource("src/server/http.ts")).toBe(true);
    expect(isScoredSource("web/src/App.tsx")).toBe(true);
    expect(isScoredSource("src-tauri/src/lib.rs")).toBe(true);
    expect(isScoredSource("test/evolution-server.test.ts")).toBe(false);
    expect(isScoredSource("web/src/App.test.tsx")).toBe(false);
    expect(isScoredSource("web/e2e/workbench.e2e.ts")).toBe(false);
    expect(isScoredSource("docs/readme.md")).toBe(false);
  });
});

describe("clearMetrics", () => {
  it("removes a metrics file left by an earlier run", async () => {
    const { clearMetrics } = await import("../scripts/ub-quality-gate.mjs");
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-metrics-"));
    await mkdir(path.join(root, ".metrics"), { recursive: true });
    const metrics = path.join(root, ".metrics", "crap.edn");
    await writeFile(metrics, "{:name \"stale\"}\n", "utf8");

    expect(clearMetrics(root)).toBe(true);
    expect(existsSync(metrics)).toBe(false);
  });

  it("says so when there was nothing to clear", async () => {
    const { clearMetrics } = await import("../scripts/ub-quality-gate.mjs");
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-metrics-"));
    expect(clearMetrics(root)).toBe(false);
  });

  it("stops the baseline step from reading a measurement of older code", async () => {
    // A stale file claiming a function scored 999 would otherwise be reported as a
    // regression against the frozen baseline; clearing it makes the run honest.
    const { clearMetrics, baselineStep } = await import("../scripts/ub-quality-gate.mjs");
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-metrics-"));
    await mkdir(path.join(root, ".metrics"), { recursive: true });
    await writeFile(
      path.join(root, ".metrics", "crap.edn"),
      '{:name "gone", :namespace "ghost", :complexity 30, :coverage 0.0, :crap 999.0}\n',
      "utf8",
    );
    await writeFile(
      path.join(root, "baseline.json"),
      JSON.stringify({ scores: { "ghost#gone": 12 } }),
      "utf8",
    );

    clearMetrics(root);
    const status = baselineStep({ tool: "crapper", baseline: "baseline.json" }, root);
    expect(status).toBe(0);
  });
});
