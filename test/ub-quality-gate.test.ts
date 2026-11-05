import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  driftBetween,
  driftPayload,
  driftStep,
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

function gitIn(dir: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * A fixture that models the real workflow: the tree being measured *is* the commit that
 * becomes `main`. A refresh is refused on any other tree, so every baseline test starts
 * from this shape rather than from a bare directory.
 */
async function mainTree(dir: string): Promise<string> {
  gitIn(dir, "init", "-q", "-b", "main");
  gitIn(dir, "-c", "user.email=gate@example.com", "-c", "user.name=gate", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "fixture");
  const head = gitIn(dir, "rev-parse", "HEAD");
  gitIn(dir, "update-ref", "refs/remotes/origin/main", head);
  // The complexity census these fixtures inherit. It names the one key their stub tools emit, so
  // the newcomer allowance has nothing to say and each test stays about what it is about — the
  // ledger, the merge, the base check. A fixture that wants a newcomer writes its own census.
  await writeFile(
    path.join(dir, ".ub-cc-baseline.json"),
    JSON.stringify({ total: 1, counts: { "a#f": 5 } }),
    "utf8",
  );
  return head;
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
      ccBaseline: ".ub-cc-baseline.json",
      updateCcBaseline: false,
      updateBaseline: false,
      driftReport: "",
      coverageA: "",
      coverageB: "",
      coverageC: "",
      expectBase: "",
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
    // Whatever these entries describe is already known: this fixture is about the CRAP ledger,
    // and an unknown function over the allowance would refuse before the ledger is read.
    const known = Object.fromEntries(
      [
        ...scores
          .join("\n")
          .matchAll(/:name "([^"]*)", :namespace "([^"]*)", :complexity (\d+)/g),
      ].map((match) => [`${match[2]}#${match[1]}`, Number(match[3])]),
    );
    await writeFile(
      path.join(root, ".ub-cc-baseline.json"),
      JSON.stringify({ total: Object.keys(known).length, counts: known }),
      "utf8",
    );
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

describe("stale coverage", () => {
  const existing = { extra: ["--use-existing-coverage"] };

  /** A tree with one source file and one coverage report, with their ages set explicitly. */
  async function coverageTree(reportAgeSeconds: number) {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-fresh-"));
    const source = path.join(root, "src", "journal.ts");
    const report = path.join(root, "target", "coverage", "typescript", "lcov.info");
    await mkdir(path.dirname(source), { recursive: true });
    await mkdir(path.dirname(report), { recursive: true });
    await writeFile(source, "export const a = 1;\n", "utf8");
    await writeFile(report, "SF:src/journal.ts\nDA:1,1\nend_of_record\n", "utf8");
    const now = Math.floor(Date.now() / 1000);
    await utimes(source, now - 100, now - 100);
    await utimes(report, now - 100 + reportAgeSeconds, now - 100 + reportAgeSeconds);
    return { root, source, report };
  }

  it("refuses to score a report older than the code it would be scored against", async () => {
    // The real failure this stops: vitest pointed at another reportsDirectory leaves the
    // report crapper reads at its old path, and today's functions get yesterday's line
    // numbers. A correct function measured 210.0 that way, and nothing in the run said so.
    const { staleCoverageRefusal } = await import("../scripts/ub-quality-gate.mjs");
    const { root } = await coverageTree(-60);

    expect(staleCoverageRefusal(existing, root)).toBe(1);
  });

  it("scores a report produced after the last source change", async () => {
    const { staleCoverageRefusal } = await import("../scripts/ub-quality-gate.mjs");
    const { root } = await coverageTree(60);

    expect(staleCoverageRefusal(existing, root)).toBeUndefined();
  });

  it("says nothing when the gate regenerates its own coverage", async () => {
    // Self mode deletes the report and runs the tests itself, so an old file cannot be read.
    const { staleCoverageRefusal } = await import("../scripts/ub-quality-gate.mjs");
    const { root } = await coverageTree(-60);

    expect(staleCoverageRefusal({ extra: [] }, root)).toBeUndefined();
  });

  it("checks the refresh inputs, not the report they are about to replace", async () => {
    // A refresh copies `--coverage-a` over the canonical path, so the canonical file's age
    // says nothing; the inputs are the ones that get scored.
    const { staleCoverageRefusal } = await import("../scripts/ub-quality-gate.mjs");
    const { root } = await coverageTree(60);
    const now = Math.floor(Date.now() / 1000);
    for (const name of ["a.info", "b.info"]) {
      const file = path.join(root, name);
      await writeFile(file, "SF:src/journal.ts\nDA:1,1\nend_of_record\n", "utf8");
      await utimes(file, now - 100, now - 100);
    }

    expect(
      staleCoverageRefusal(
        { ...existing, updateBaseline: true, coverageA: "a.info", coverageB: "b.info" },
        root,
      ),
    ).toBe(1);
  });

  it("ignores build output and installed dependencies", async () => {
    // Otherwise any `pnpm build` or `pnpm install` would declare every report stale, and a
    // gate that fires for the wrong reason gets switched off.
    const { staleCoverageRefusal } = await import("../scripts/ub-quality-gate.mjs");
    const { root } = await coverageTree(60);
    const now = Math.floor(Date.now() / 1000);
    for (const directory of ["node_modules", "dist", "target"]) {
      const file = path.join(root, directory, "generated.ts");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "export const later = 1;\n", "utf8");
      await utimes(file, now, now);
    }

    expect(staleCoverageRefusal(existing, root)).toBeUndefined();
  });

  it("walks nested source directories and only counts files the layers read", async () => {
    // The scored tree is not flat, and it holds things that are not source: notes, fixtures,
    // JSON. A file the layers never read cannot make the report stale.
    const { staleCoverageRefusal } = await import("../scripts/ub-quality-gate.mjs");
    const { root } = await coverageTree(60);
    const now = Math.floor(Date.now() / 1000);
    const notes = path.join(root, "src", "nested", "notes.md");
    const fixture = path.join(root, "src", "nested", "fixture.json");
    await mkdir(path.dirname(notes), { recursive: true });
    for (const file of [notes, fixture]) {
      await writeFile(file, "{}\n", "utf8");
      await utimes(file, now, now);
    }

    expect(staleCoverageRefusal(existing, root)).toBeUndefined();
  });

  it("counts a nested source file, wherever the newest change is", async () => {
    const { staleCoverageRefusal } = await import("../scripts/ub-quality-gate.mjs");
    const { root } = await coverageTree(-60);
    const now = Math.floor(Date.now() / 1000);
    const deep = path.join(root, "web", "src", "components", "Panel.tsx");
    await mkdir(path.dirname(deep), { recursive: true });
    await writeFile(deep, "export const Panel = () => null;\n", "utf8");
    await utimes(deep, now, now);

    expect(staleCoverageRefusal(existing, root)).toBe(1);
  });

  it("reports staleness as infrastructure, never as an empty ledger", async () => {
    // The tool must never run in this test: staleness is decided before it is called, which
    // is the point — a stub that is never invoked proves the gate stopped at the input.
    const tool = await stubTool("exit 0");
    const { root } = await coverageTree(-60);
    await writeFile(
      path.join(root, "baseline.json"),
      JSON.stringify({ scores: {} }),
      "utf8",
    );
    const read = spawnSync(
      process.execPath,
      [
        script,
        "--all",
        "--baseline",
        "baseline.json",
        "--drift-report",
        "drift.json",
        "--",
        "--use-existing-coverage",
      ],
      { cwd: root, encoding: "utf8", env: { ...process.env, UB_BIN: tool } },
    );

    expect(read.status).toBe(1);
    const payload = JSON.parse(await readFile(path.join(root, "drift.json"), "utf8"));
    expect(payload.kind).toBe("infrastructure");
    expect(payload.error).toContain("stale");
  });
});

describe("new functions must stay simple", () => {
  const existing = { ccBaseline: "census.json", extra: [] };
  /** One EDN entry in the shape crapper writes. */
  const fn = (namespace: string, name: string, complexity: number) =>
    `{:name "${name}", :namespace "${namespace}", :complexity ${complexity}, ` +
    `:coverage 100.0, :crap ${complexity}}`;

  async function workdir(entries: string[], census: Record<string, number> | undefined) {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-cc-"));
    await mkdir(path.join(root, ".metrics"), { recursive: true });
    await writeFile(
      path.join(root, ".metrics", "crap.edn"),
      `{:entries [\n${entries.join("\n")}\n]}\n`,
      "utf8",
    );
    if (census) {
      await writeFile(
        path.join(root, "census.json"),
        JSON.stringify({ total: Object.keys(census).length, counts: census }),
        "utf8",
      );
    }
    return root;
  }

  it("refuses a function the census has never seen that is over the allowance", async () => {
    // The whole point: a freshly split block is unknown, and unknown means "prove it is small".
    // Coverage is deliberately not consulted — cc 9 at 100% coverage is still CRAP 9.0, on the
    // line with nothing left over.
    const { newcomerRefusal, readFunctions } = await import("../scripts/ub-quality-gate.mjs");
    const known = { "mod#steady": 2 };
    const root = await workdir([fn("mod", "steady", 2), fn("mod", "fresh", 5)], known);

    expect(newcomerRefusal(existing, readFunctions(path.join(root, ".metrics", "crap.edn")), root))
      .toBe(1);
  });

  it("accepts a newcomer at the allowance itself", async () => {
    const { newcomerRefusal, readFunctions } = await import("../scripts/ub-quality-gate.mjs");
    const root = await workdir([fn("mod", "fresh", 4)], { "mod#steady": 2 });

    expect(
      newcomerRefusal(existing, readFunctions(path.join(root, ".metrics", "crap.edn")), root),
    ).toBeUndefined();
  });

  it("says nothing about a known function however complex it is", async () => {
    // The allowance is about arrival, not about history: debt that already exists is the CRAP
    // ledger's subject, and this gate must not become a second, stricter ledger.
    const { newcomerRefusal, readFunctions } = await import("../scripts/ub-quality-gate.mjs");
    const root = await workdir([fn("mod", "old-and-big", 9)], { "mod#old-and-big": 9 });

    expect(
      newcomerRefusal(existing, readFunctions(path.join(root, ".metrics", "crap.edn")), root),
    ).toBeUndefined();
  });

  it("refuses the run when there is no census at all", async () => {
    // A missing census reads as "every function is new", which would fail every run and get the
    // gate switched off. So it is refused with the command that fixes it, not passed silently.
    const { newcomerRefusal, readFunctions } = await import("../scripts/ub-quality-gate.mjs");
    const root = await workdir([fn("mod", "steady", 2)], undefined);

    expect(newcomerRefusal(existing, readFunctions(path.join(root, ".metrics", "crap.edn")), root))
      .toBe(1);
  });

  it("treats a renamed function as a newcomer, on purpose", async () => {
    // Renaming is the cheapest way out of any "known functions" rule, so it has to land in the
    // newcomer set. The way out is deleting the old key with a reason in the commit, not a flag.
    const { overComplexNewcomers } = await import("../scripts/ub-quality-gate.mjs");
    const functions = new Map([["mod#renamed", { complexity: 7, coverage: 100, crap: 7 }]]);

    expect(overComplexNewcomers(functions, { "mod#original": 7 })).toEqual([["mod#renamed", 7]]);
  });

  it("reports the worst newcomers first", async () => {
    const { overComplexNewcomers } = await import("../scripts/ub-quality-gate.mjs");
    const functions = new Map([
      ["m#a", { complexity: 5, coverage: 100, crap: 5 }],
      ["m#b", { complexity: 11, coverage: 100, crap: 11 }],
    ]);

    expect(overComplexNewcomers(functions, {})).toEqual([
      ["m#b", 11],
      ["m#a", 5],
    ]);
  });

  it("stops a refresh from turning a newcomer into an existing function", async () => {
    // The three-step bypass this closes: split out a cc 9 block, run --update-baseline, and the
    // next run treats it as history. A refresh closes debt; it does not open the allowance.
    const root = await workdir([fn("mod", "fresh", 9)], {});
    // The stub writes the measurement it "produced": the gate clears `.metrics` before each
    // scan, so a stub that writes nothing would look like a scan that measured nothing.
    await writeFile(
      path.join(root, "scan.edn"),
      `{:entries [\n${fn("mod", "fresh", 9)}\n]}\n`,
      "utf8",
    );
    const tool = await stubTool("mkdir -p .metrics && cp scan.edn .metrics/crap.edn");
    await mainTree(root);
    await writeFile(
      path.join(root, "baseline.json"),
      JSON.stringify({ scores: {} }),
      "utf8",
    );
    await writeFile(path.join(root, "a.info"), "SF:mod.ts\nDA:1,1\nend_of_record\n", "utf8");
    await writeFile(path.join(root, "b.info"), "SF:mod.ts\nDA:1,1\nend_of_record\n", "utf8");
    const result = spawnSync(
      process.execPath,
      [
        script,
        "--all",
        "--update-baseline",
        "--cc-baseline",
        "census.json",
        "--coverage-a",
        "a.info",
        "--coverage-b",
        "b.info",
        "--",
        "--use-existing-coverage",
      ],
      { cwd: root, encoding: "utf8", env: { ...process.env, UB_BIN: tool } },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("above the complexity allowance");
    expect(JSON.parse(await readFile(path.join(root, "baseline.json"), "utf8")).scores).toEqual({});
  });
});

describe("nightly drift report", () => {
  const score = (namespace: string, name: string, crap: number) =>
    `{:name "${name}", :namespace "${namespace}", :complexity 5, :coverage 0.0, :crap ${crap}}`;

  async function driftWorkdir(scores: string[], baseline: Record<string, number> | undefined) {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-drift-"));
    await mkdir(path.join(root, ".metrics"), { recursive: true });
    if (scores.length > 0) {
      await writeFile(path.join(root, ".metrics", "crap.edn"), scores.join("\n"), "utf8");
    }
    if (baseline) {
      await writeFile(
        path.join(root, "base.json"),
        JSON.stringify({ updatedAt: "2026-01-01T00:00:00.000Z", scores: baseline }),
        "utf8",
      );
    }
    return root;
  }

  it("classifies appeared, grown and paid debt", () => {
    const scores = new Map([
      ["a#new-debt", 40],
      ["a#grown", 55],
      ["a#paid", 8],
      ["a#same", 30],
    ]);
    const baseline = { "a#grown": 50, "a#paid": 60, "a#same": 30, "a#gone": 70 };
    const report = driftBetween(scores, baseline, 10);
    expect(report.new.map((entry) => entry.key)).toEqual(["a#new-debt"]);
    expect(report.worse).toEqual([{ key: "a#grown", score: 55, frozen: 50 }]);
    expect(report.fixed.map((entry) => entry.key)).toEqual(["a#gone", "a#paid"]);
    expect(report.worse[0]!.score).toBe(55);
  });

  it("refuses to read error without narrowing on kind", () => {
    const ledger = driftPayload({ report: driftBetween(new Map(), {}, 10), threshold: 10 });
    // The ledger branch has no `error` at all. If this line ever compiles, the
    // union was flattened back into one object with an optional field and every
    // consumer lost the obligation to narrow — which is how the nightly issue
    // reported "unknown error" for scans that had not run.
    // @ts-expect-error - reading a field that only the infrastructure branch declares.
    expect(ledger.error).toBeUndefined();
  });

  it("marks an infrastructure verdict instead of an empty ledger", () => {
    const ledger = driftPayload({ report: driftBetween(new Map(), {}, 10), threshold: 10 });
    expect(ledger).toMatchObject({ kind: "ledger", counts: { new: 0, worse: 0, fixed: 0 } });
    // Not `ledger.error === undefined`: on the ledger branch the field does not
    // exist at all, and reading it is a compile error. `.not.toHaveProperty`
    // states that without asking the type to pretend otherwise.
    expect(ledger).not.toHaveProperty("error");

    const broken = driftPayload({ error: "gate: layer exited 1", threshold: 10 });
    expect(broken).toMatchObject({
      kind: "infrastructure",
      error: "gate: layer exited 1",
      counts: { new: 0, worse: 0, fixed: 0 },
    });
  });

  it("writes the verdict and exits 0 on a full scan", async () => {
    const root = await driftWorkdir(
      [score("a", "new-debt", 40), score("a", "grown", 55)],
      { "a#grown": 50, "a#paid": 60 },
    );
    const tool = await stubTool(
      `mkdir -p "${path.join(root, ".metrics")}" && cat > "${path.join(root, ".metrics", "crap.edn")}" <<'EDN'
{:name "new-debt", :namespace "a", :complexity 5, :coverage 0.0, :crap 40.0}
{:name "grown", :namespace "a", :complexity 5, :coverage 0.0, :crap 55.0}
EDN`,
    );
    const options = { ...parseArgs(["--drift-report", "drift.json", "--baseline", "base.json"], {}) };
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(driftStep(options, tool, root)).toBe(0);
    vi.restoreAllMocks();
    const written = JSON.parse(await readFile(path.join(root, "drift.json"), "utf8"));
    expect(written.kind).toBe("ledger");
    expect(written.counts).toEqual({ new: 1, worse: 1, fixed: 1 });
    expect(written.new[0]).toMatchObject({ key: "a#new-debt", score: 40 });
    expect(written.worse[0]).toMatchObject({ key: "a#grown", frozen: 50 });
    expect(written.fixed[0]).toMatchObject({ key: "a#paid", frozen: 60 });
  });

  it("reads exit 2 as a ledger verdict, not as a broken scan", async () => {
    // A full scan of a repo with a frozen baseline always exits 2 (scores over the
    // threshold). Treating that as infrastructure reported every nightly run broken.
    const root = await driftWorkdir([], { "a#grown": 50, "a#paid": 60 });
    const metrics = path.join(root, ".metrics", "crap.edn");
    const tool = await stubTool(
      `mkdir -p "${path.join(root, ".metrics")}" && printf '%s\\n' '{:name "grown", :namespace "a", :complexity 5, :coverage 0.0, :crap 55.0}' > "${metrics}" && exit 2`,
    );
    const options = { ...parseArgs(["--drift-report", "drift.json", "--baseline", "base.json"], {}) };
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(driftStep(options, tool, root)).toBe(0);
    vi.restoreAllMocks();
    const written = JSON.parse(await readFile(path.join(root, "drift.json"), "utf8"));
    expect(written.kind).toBe("ledger");
    expect(written.counts).toEqual({ new: 0, worse: 1, fixed: 1 });
  });

  it("reports a crashed scan as infrastructure, never as a clean ledger", async () => {
    const root = await driftWorkdir([], { "a#big": 50 });
    const crashed = await stubTool("exit 1");
    const options = { ...parseArgs(["--drift-report", "drift.json", "--baseline", "base.json"], {}) };
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(driftStep(options, crashed, root)).toBe(1);
    vi.restoreAllMocks();
    const written = JSON.parse(await readFile(path.join(root, "drift.json"), "utf8"));
    expect(written.kind).toBe("infrastructure");
    expect(written.error).toContain("exited 1");
    expect(written.counts).toEqual({ new: 0, worse: 0, fixed: 0 });
  });

  it("treats a missing baseline as infrastructure, not as brand-new debt", async () => {
    const root = await driftWorkdir([], undefined);
    const tool = await stubTool(
      `mkdir -p "${path.join(root, ".metrics")}" && echo '{:name "big", :namespace "a", :complexity 5, :coverage 0.0, :crap 40.0}' > "${path.join(root, ".metrics", "crap.edn")}"`,
    );
    const options = { ...parseArgs(["--drift-report", "drift.json", "--baseline", "missing.json"], {}) };
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(driftStep(options, tool, root)).toBe(1);
    vi.restoreAllMocks();
    const written = JSON.parse(await readFile(path.join(root, "drift.json"), "utf8"));
    expect(written.kind).toBe("infrastructure");
    expect(written.error).toContain("baseline missing");
  });
});

describe("coverage drift issue plan", () => {
  it("opens a ledger issue that lists appeared and grown debt", async () => {
    const { issuePlan } = await import("../scripts/coverage-drift-issue.mjs");
    const plan = issuePlan({
      kind: "ledger",
      generatedAt: "2026-11-02T00:00:00.000Z",
      threshold: 10,
      baseline: ".ub-crap-baseline.json",
      counts: { new: 1, worse: 1, fixed: 2 },
      new: [{ key: "a#fresh", score: 40 }],
      worse: [{ key: "a#grown", score: 55, frozen: 50 }],
      fixed: [{ key: "a#paid", frozen: 60 }],
    });
    expect(plan).toMatchObject({ kind: "ledger", shouldClose: false });
    expect(plan.title).toContain("账本上涨");
    expect(plan.body).toContain("| 1 | 1 | 2 |");
    expect(plan.body).toContain("a#fresh — 40.0");
    expect(plan.body).toContain("a#grown — 55.0（基线 50.0）");
    expect(plan.body).toContain("a#paid（基线 60.0）");
  });

  it("appends the attribution to the verdict it explains, not as its own issue", async () => {
    const { issuePlan } = await import("../scripts/coverage-drift-issue.mjs");
    const plan = issuePlan(
      { kind: "ledger", counts: { new: 1, worse: 0, fixed: 0 }, new: [{ key: "a#fresh", score: 40 }] },
      {
        attribution: {
          status: "measured",
          repeats: 3,
          modes: ["existing"],
          summary: { stable: 1, "run-sensitive": 0 },
          rows: [{ key: "a#fresh", ledger: 40, perCommit: { HEAD: { existing: [40, 40, 40.2] } }, verdict: "stable" }],
        },
      },
    );
    expect(plan.body).toContain("新增债务");
    expect(plan.body).toContain("### 归因（caliber）");
    expect(plan.body).toContain("| `a#fresh` | `stable` | 40.00 | 40.00 · 40.00 · 40.20 |");
    expect(plan.body.indexOf("### 归因")).toBeGreaterThan(plan.body.indexOf("新增债务"));
  });

  it("says nothing about attribution when there was none", async () => {
    const { issuePlan, readAttribution } = await import("../scripts/coverage-drift-issue.mjs");
    const plan = issuePlan({ kind: "ledger", counts: { new: 0, worse: 0, fixed: 1 } });
    expect(plan.body).not.toContain("归因");
    expect(readAttribution("/definitely/not/here.json")).toBeUndefined();
  });

  it("closes instead of opening when the ledger did not grow", async () => {
    const { issuePlan } = await import("../scripts/coverage-drift-issue.mjs");
    const plan = issuePlan({ kind: "ledger", counts: { new: 0, worse: 0, fixed: 3 } });
    expect(plan.shouldClose).toBe(true);
    expect(plan.body).toContain("账本没有上涨");
  });

  it("keeps an infrastructure failure apart from a clean ledger", async () => {
    const { issuePlan } = await import("../scripts/coverage-drift-issue.mjs");
    const plan = issuePlan({
      kind: "infrastructure",
      error: "ub-mode tool chain not found",
      counts: { new: 0, worse: 0, fixed: 0 },
    });
    expect(plan.shouldClose).toBe(false);
    expect(plan.title).toContain("基础设施失败");
    expect(plan.body).toContain("这不是账本结论");
    expect(plan.body).toContain("ub-mode tool chain not found");
    // Zero counters must never read as "clean" when the scan itself broke.
    expect(plan.title).not.toBe("Coverage drift · 账本上涨");
  });
});

describe("drift report loading", () => {
  it("treats a missing or unreadable report as infrastructure", async () => {
    const { readReport, reportFromText } = await import("../scripts/coverage-drift-issue.mjs");
    expect(readReport("/definitely/not/here.json")).toMatchObject({ kind: "infrastructure" });
    expect(reportFromText("not json").kind).toBe("infrastructure");
    expect(reportFromText("{}").kind).toBe("infrastructure");
    expect(reportFromText(JSON.stringify({ kind: "ledger", counts: { new: 0, worse: 0, fixed: 0 } })).kind)
      .toBe("ledger");
  });
});

describe("drift issue lifecycle", () => {
  function recorder(issues: Array<{ number: number; title: string }>, failOn?: string) {
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      if (failOn && args[0] === "issue" && args[1] === failOn) {
        return { status: 1, stdout: "", stderr: "boom" };
      }
      if (args[1] === "list") return { status: 0, stdout: JSON.stringify(issues), stderr: "" };
      if (args[1] === "create") return { status: 0, stdout: "https://example.test/1\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    return { gh, calls };
  }

  it("creates a ledger issue when none exists", async () => {
    const { applyPlan, issuePlan } = await import("../scripts/coverage-drift-issue.mjs");
    const { gh, calls } = recorder([]);
    const plan = issuePlan({ kind: "ledger", counts: { new: 1, worse: 0, fixed: 0 }, new: [{ key: "a#b", score: 11 }] });
    expect(applyPlan(plan, { gh })).toMatchObject({ action: "created" });
    expect(calls.some((args) => args[1] === "create")).toBe(true);
  });

  it("updates the issue that already carries this verdict", async () => {
    const { applyPlan, issuePlan } = await import("../scripts/coverage-drift-issue.mjs");
    const plan = issuePlan({ kind: "ledger", counts: { new: 1, worse: 0, fixed: 0 }, new: [{ key: "a#b", score: 11 }] });
    const { gh, calls } = recorder([{ number: 7, title: plan.title }]);
    expect(applyPlan(plan, { gh })).toMatchObject({ action: "updated", issues: [7] });
    expect(calls.some((args) => args[1] === "edit")).toBe(true);
  });

  it("closes everything when the ledger stopped growing", async () => {
    const { applyPlan, issuePlan } = await import("../scripts/coverage-drift-issue.mjs");
    const plan = issuePlan({ kind: "ledger", counts: { new: 0, worse: 0, fixed: 2 } });
    const { gh, calls } = recorder([{ number: 7, title: "【待分诊】Coverage drift · 账本上涨" }]);
    expect(applyPlan(plan, { gh })).toMatchObject({ action: "closed", issues: [7] });
    expect(calls.filter((args) => args[1] === "close")).toHaveLength(1);
  });

  it("closes an infrastructure issue only because a scan completed", async () => {
    const { applyPlan, issuePlan } = await import("../scripts/coverage-drift-issue.mjs");
    const plan = issuePlan({ kind: "ledger", counts: { new: 1, worse: 0, fixed: 0 }, new: [{ key: "a#b", score: 11 }] });
    const { gh, calls } = recorder([{ number: 157, title: "Coverage drift · 基础设施失败" }]);
    applyPlan(plan, { gh });
    const closed = calls.find((args) => args[1] === "close");
    expect(closed?.[2]).toBe("157");
    expect(closed?.join(" ")).toContain("扫描已完成");
  });

  it("never closes a ledger issue because the scan broke", async () => {
    const { applyPlan, issuePlan } = await import("../scripts/coverage-drift-issue.mjs");
    const plan = issuePlan({ kind: "infrastructure", error: "crash", counts: { new: 0, worse: 0, fixed: 0 } });
    const { gh, calls } = recorder([{ number: 160, title: "【待分诊】Coverage drift · 账本上涨" }]);
    applyPlan(plan, { gh });
    expect(calls.some((args) => args[1] === "close")).toBe(false);
  });

  it("raises when gh cannot list issues", async () => {
    const { applyPlan, issuePlan } = await import("../scripts/coverage-drift-issue.mjs");
    const plan = issuePlan({ kind: "ledger", counts: { new: 0, worse: 0, fixed: 0 } });
    const gh = () => ({ status: 1, stdout: "", stderr: "no token" });
    expect(() => applyPlan(plan, { gh })).toThrow(/gh issue list failed/);
  });
});

describe("baseline stability guard", () => {
  it("reports keys two scans disagree about", async () => {
    const { unstableKeys } = await import("../scripts/ub-quality-gate.mjs");
    expect(unstableKeys(new Map([["a", 40]]), new Map([["a", 40]]))).toEqual([]);
    const drift = unstableKeys(new Map([["a", 40]]), new Map([["a", 80], ["b", 33]]));
    expect(drift.map((entry) => entry.key)).toEqual(["a", "b"]);
    // Sub-5% jitter is measurement noise, not a reason to refuse a baseline.
    expect(unstableKeys(new Map([["a", 40]]), new Map([["a", 41.5]]))).toEqual([]);
    expect(unstableKeys(new Map([["a", 40]]), new Map([["a", 12]]))).toHaveLength(1);
    // Wobble below the ledger line produces no debt either way: it must not block.
    expect(unstableKeys(new Map([["a", 5.9]]), new Map([["a", 5.07]]))).toEqual([]);
    expect(unstableKeys(new Map([["a", 5.9]]), new Map([["a", 6.5]]))).toEqual([]);
    // A function sitting on the line does: one scan freezes it, the other does not.
    expect(unstableKeys(new Map([["a", 9.8]]), new Map([["a", 10.2]]))).toHaveLength(1);
    // A trivial function moving 1.00 -> 1.13 is noise, not drift.
    expect(unstableKeys(new Map([["a", 1]]), new Map([["a", 1.125]]))).toEqual([]);
  });

  it("refuses to write a baseline when the scans disagree", async () => {
    const { stableBaseline } = await import("../scripts/ub-quality-gate.mjs");
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-baseline-stable-"));
    await mainTree(root);
    const counter = path.join(root, "calls");
    // A tool that returns a different score on each invocation: exactly the wobble
    // that froze 20.24 for a function that measures 23.90.
    const tool = await stubTool(
      `mkdir -p "${path.join(root, ".metrics")}"; n=$(cat "${counter}" 2>/dev/null || echo 0); echo $((n+1)) > "${counter}"; ` +
        `echo "{:name \\"f\\", :namespace \\"a\\", :complexity 5, :coverage 0.0, :crap $((100+n*60))}" > "${path.join(root, ".metrics", "crap.edn")}"`,
    );
    const options = { ...parseArgs(["--update-baseline", "--baseline", "base.json"], {}) };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(stableBaseline(tool, options, root)).toBe(2);
    stderr.mockRestore();
    expect(existsSync(path.join(root, "base.json"))).toBe(false);
  });

  it("writes the baseline when two scans agree", async () => {
    const { stableBaseline } = await import("../scripts/ub-quality-gate.mjs");
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-baseline-stable-ok-"));
    await mainTree(root);
    const tool = await stubTool(
      `mkdir -p "${path.join(root, ".metrics")}"; echo '{:name "f", :namespace "a", :complexity 5, :coverage 0.0, :crap 120.0}' > "${path.join(root, ".metrics", "crap.edn")}"`,
    );
    const options = { ...parseArgs(["--update-baseline", "--baseline", "base.json"], {}) };
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(stableBaseline(tool, options, root)).toBe(0);
    stdout.mockRestore();
    const written = JSON.parse(await readFile(path.join(root, "base.json"), "utf8"));
    expect(written.scores).toEqual({ "a#f": 120 });
  });
});

describe("drift provenance", () => {
  it("pins the coverage report the scores came from", async () => {
    const { lcovProvenance } = await import("../scripts/ub-quality-gate.mjs");
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-provenance-"));
    const file = path.join(root, "lcov.info");
    await writeFile(file, "SF:src/a.ts\nLF:1\nLH:1\n", "utf8");
    const pinned = lcovProvenance(file);
    expect(pinned?.bytes).toBe(Buffer.byteLength("SF:src/a.ts\nLF:1\nLH:1\n"));
    expect(pinned?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lcovProvenance(path.join(root, "missing.info"))).toBeUndefined();
  });

  it("carries head, tool, source and machine in the payload", async () => {
    const { driftPayload } = await import("../scripts/ub-quality-gate.mjs");
    const payload = driftPayload({
      report: { new: [], worse: [], fixed: [], withinNoise: [] },
      provenance: {
        headSha: "abc",
        toolCommit: "6fd92c4",
        coverageSource: "self",
        platform: "darwin/arm64",
        nodeVersion: "v26.5.0",
        lcov: { path: "x", bytes: 1, sha256: "d" },
      },
    });
    expect(payload.provenance).toMatchObject({
      headSha: "abc",
      toolCommit: "6fd92c4",
      coverageSource: "self",
      lcov: { bytes: 1 },
    });
  });
});

describe("baseline generation provenance", () => {
  it("records how the frozen numbers were produced", async () => {
    const { stableBaseline } = await import("../scripts/ub-quality-gate.mjs");
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-baseline-generation-"));
    await mainTree(root);
    const counter = path.join(root, "calls");
    const lcov = path.join(root, "target", "coverage", "typescript", "lcov.info");
    // Same scores both times, but each scan writes its own coverage report — the
    // numbers agree, and the provenance says which two reports they agreed about.
    const tool = await stubTool(
      `mkdir -p "$(dirname "${lcov}")" "${path.join(root, ".metrics")}"; ` +
        `n=$(cat "${counter}" 2>/dev/null || echo 0); echo $((n+1)) > "${counter}"; ` +
        `printf 'SF:src/a.ts\\nLF:1\\nLH:1\\nscan %s\\n' "$n" > "${lcov}"; ` +
        `echo '{:name "f", :namespace "a", :complexity 5, :coverage 0.0, :crap 120.0}' > "${path.join(root, ".metrics", "crap.edn")}"`,
    );
    const options = { ...parseArgs(["--update-baseline", "--baseline", "base.json"], {}) };
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(stableBaseline(tool, options, root)).toBe(0);
    stdout.mockRestore();

    const written = JSON.parse(await readFile(path.join(root, "base.json"), "utf8"));
    expect(written.scores).toEqual({ "a#f": 120 });
    expect(written.generation).toMatchObject({
      scans: 2,
      coverageSource: "self",
      platform: expect.stringContaining("/"),
      nodeVersion: expect.stringMatching(/^v\d+\./),
    });
    // The frozen report is recorded in the shape the baseline file already uses, and
    // the second scan's digest keeps the "two scans agreed" claim checkable.
    expect(written.generation.lcov).toMatchObject({ path: expect.stringContaining("lcov.info") });
    expect(written.generation.lcov.sha256).toMatch(/^[0-9a-f]{64}$/);
    const digests = written.generation.agreement.sha256 as string[];
    expect(digests).toHaveLength(2);
    expect(digests.every((digest) => /^[0-9a-f]{64}$/.test(digest))).toBe(true);
    expect(new Set(digests).size).toBe(2);
  });
});

describe("stability guard tells noise from drift", () => {
  it("keeps sub-threshold wobble out of the gate and blocks a threshold crossover", async () => {
    const { unstableKeys } = await import("../scripts/ub-quality-gate.mjs");
    // Below the line in both scans: cannot enter the ledger, must not block.
    expect(unstableKeys(new Map([["a", 5.9]]), new Map([["a", 5.1]]))).toEqual([]);
    // One scan freezes it, the other does not: this is what makes a ledger flaky.
    expect(unstableKeys(new Map([["a", 9.8]]), new Map([["a", 10.2]]))).toHaveLength(1);
    // A key that disappeared from one scan entirely.
    expect(unstableKeys(new Map([["a", 40]]), new Map())).toHaveLength(1);
  });

  it("prints what moved when it refuses", async () => {
    const { stableBaseline } = await import("../scripts/ub-quality-gate.mjs");
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-baseline-refuse-"));
    await mainTree(root);
    const counter = path.join(root, "calls");
    const tool = await stubTool(
      `mkdir -p "${path.join(root, ".metrics")}"; n=$(cat "${counter}" 2>/dev/null || echo 0); echo $((n+1)) > "${counter}"; ` +
        `echo "{:name \\"f\\", :namespace \\"a\\", :complexity 5, :coverage 0.0, :crap $((40+n*40))}" > "${path.join(root, ".metrics", "crap.edn")}"`,
    );
    const options = { ...parseArgs(["--update-baseline", "--baseline", "base.json"], {}) };
    const messages: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      messages.push(String(chunk));
      return true;
    });
    expect(stableBaseline(tool, options, root)).toBe(2);
    stderr.mockRestore();
    const printed = messages.join("");
    expect(printed).toContain("refusing to write");
    expect(printed).toMatch(/a#f: \d+ -> \d+/);
  });
});

describe("drift line rendering", () => {
  it("says how far a score moved when the deviation is known", async () => {
    const { describeDrift } = await import("../scripts/ub-quality-gate.mjs");
    expect(describeDrift({ key: "a#f", first: 40, second: 55, deviation: 0.2727 })).toBe(
      "a#f: 40 -> 55 (27.3%)",
    );
    expect(describeDrift({ key: "a#g", first: 12, second: 40 })).toBe("a#g: 12 -> 40");
    expect(describeDrift({ key: "a#h", second: 40 })).toBe("a#h: absent -> 40");
  });
});

describe("drift noise band", () => {
  const scores = (pairs: Array<[string, number]>) => new Map(pairs);

  it("keeps a move inside the band out of the debt lists", async () => {
    const { driftBetween } = await import("../scripts/ub-quality-gate.mjs");
    const report = driftBetween(scores([["a", 10.3]]), { "a": 10.2 }, 10);
    expect(report.worse).toEqual([]);
    expect(report.new).toEqual([]);
    expect(report.withinNoise).toEqual([{ key: "a", score: 10.3, frozen: 10.2 }]);
  });

  it("reports a move beyond the band as worse", async () => {
    const { driftBetween } = await import("../scripts/ub-quality-gate.mjs");
    const report = driftBetween(scores([["b", 16.2]]), { "b": 15.0 }, 10);
    expect(report.worse).toEqual([{ key: "b", score: 16.2, frozen: 15 }]);
    expect(report.withinNoise).toEqual([]);
  });

  it("reports a crossing of the ledger line as worse however small it looks", async () => {
    const { driftBetween } = await import("../scripts/ub-quality-gate.mjs");
    const report = driftBetween(scores([["c", 10.4]]), { "c": 9.8 }, 10);
    expect(report.worse).toEqual([{ key: "c", score: 10.4, frozen: 9.8 }]);
    expect(report.withinNoise).toEqual([]);
  });

  it("does not count noise entries in the payload", async () => {
    const { driftBetween, driftPayload } = await import("../scripts/ub-quality-gate.mjs");
    const payload = driftPayload({
      report: driftBetween(scores([["a", 10.3], ["b", 16.2]]), { "a": 10.2, "b": 15.0 }, 10),
    });
    expect(payload.counts).toEqual({ new: 0, worse: 1, fixed: 0 });
    expect(payload.worse.map((entry) => entry.key)).toEqual(["b"]);
    expect(payload.withinNoise.map((entry) => entry.key)).toEqual(["a"]);
  });
});

describe("tampering with the report mid-refresh", () => {
  it("refuses when the report changed between the two scans", async () => {
    const { scanRefusal } = await import("../scripts/ub-quality-gate.mjs");
    const cwd = await mkdtemp(path.join(tmpdir(), "agent-team-tamper-"));
    const before = { sha256: "a", path: "lcov.info", bytes: 1 };
    const after = { sha256: "b", path: "lcov.info", bytes: 2 };
    const scores = new Map([["a#f", 120]]);
    // First scan ended on `before`; the second started on `after`: an edit between them.
    const status = scanRefusal(
      { existing: true, before, lcov: before, scores },
      { existing: true, before: after, lcov: after, scores },
      cwd,
    );
    expect(status).toBe(2);
  });

  it("passes the same report straight through", async () => {
    const { scanRefusal } = await import("../scripts/ub-quality-gate.mjs");
    const same = { sha256: "a", path: "lcov.info", bytes: 1 };
    const scores = new Map([["a#f", 120]]);
    const cwd = await mkdtemp(path.join(tmpdir(), "agent-team-tamper-ok-"));
    expect(
      scanRefusal(
        { existing: true, before: same, lcov: same, scores },
        { existing: true, before: same, lcov: same, scores: new Map(scores) },
        cwd,
      ),
    ).toBeUndefined();
  });
});

describe("a refresh needs two coverage runs to agree", () => {
  async function root(contents: { a?: string; b?: string }) {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-team-pair-"));
    await mainTree(dir);
    for (const [name, text] of Object.entries(contents)) {
      if (text === undefined) continue;
      await mkdir(path.join(dir, `${name}`), { recursive: true });
      await writeFile(path.join(dir, `${name}`, "lcov.info"), text, "utf8");
    }
    return dir;
  }
  const options = () =>
    parseArgs(
      [
        "--update-baseline",
        "--baseline",
        "base.json",
        "--coverage-a",
        "a/lcov.info",
        "--coverage-b",
        "b/lcov.info",
        "--",
        "--use-existing-coverage",
      ],
      {},
    );
  const same = "SF:src/a.ts\nDA:5,3\nLF:1\nLH:1\nend_of_record\n";

  it("writes when both runs produced the same report", async () => {
    const { stableBaseline } = await import("../scripts/ub-quality-gate.mjs");
    const dir = await root({ a: same, b: same });
    const tool = await stubTool(
      `mkdir -p "${path.join(dir, ".metrics")}"; echo '{:name "f", :namespace "a", :complexity 5, :coverage 0.0, :crap 120.0}' > "${path.join(dir, ".metrics", "crap.edn")}"`,
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(stableBaseline(tool, options(), dir)).toBe(0);
    stdout.mockRestore();
    const written = JSON.parse(await readFile(path.join(dir, "base.json"), "utf8"));
    expect(written.generation.coverageSource).toBe("existing");
    expect(new Set(written.generation.agreement.sha256).size).toBe(1);
  });

  it("accepts two runs of the same lines with different hit counts", async () => {
    const { stableBaseline } = await import("../scripts/ub-quality-gate.mjs");
    const dir = await root({ a: same, b: "SF:src/a.ts\nDA:5,9\nLF:1\nLH:1\nend_of_record\n" });
    const tool = await stubTool(
      `mkdir -p "${path.join(dir, ".metrics")}"; echo '{:name "f", :namespace "a", :complexity 5, :coverage 0.0, :crap 120.0}' > "${path.join(dir, ".metrics", "crap.edn")}"`,
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(stableBaseline(tool, options(), dir)).toBe(0);
    stdout.mockRestore();
    expect(existsSync(path.join(dir, "base.json"))).toBe(true);
  });

  it("keeps both samples when the runs cover different lines", async () => {
    const { stableBaseline } = await import("../scripts/ub-quality-gate.mjs");
    const differing = "SF:src/a.ts\nDA:5,9\nDA:6,1\nLF:2\nLH:2\nend_of_record\n";
    const dir = await root({ a: same, b: differing });
    const tool = await stubTool("exit 0");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(stableBaseline(tool, options(), dir)).toBe(2);
    stderr.mockRestore();
    expect(existsSync(path.join(dir, "base.json"))).toBe(false);
    // The samples are the point: a digest alone cannot show which lines were missed.
    expect(await readFile(path.join(dir, "target", "coverage", "unstable", "a", "lcov.info"), "utf8"))
      .toBe(same);
    expect(await readFile(path.join(dir, "target", "coverage", "unstable", "b", "lcov.info"), "utf8"))
      .toBe(differing);
  });

  it("refuses an existing-mode refresh that has only one report", async () => {
    const { stableBaseline } = await import("../scripts/ub-quality-gate.mjs");
    const dir = await root({ a: same });
    const tool = await stubTool("exit 0");
    const single = parseArgs(["--update-baseline", "--baseline", "base.json", "--", "--use-existing-coverage"], {});
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(stableBaseline(tool, single, dir)).toBe(3);
    stderr.mockRestore();
    expect(existsSync(path.join(dir, "base.json"))).toBe(false);
  });
});

describe("a refresh only measures the tree that becomes main", () => {
  /** HEAD one commit behind `origin/main`: the shape that froze #198 and #206. */
  async function behindTree(dir: string) {
    await mainTree(dir);
    gitIn(dir, "-c", "user.email=gate@example.com", "-c", "user.name=gate", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "ahead");
    const base = gitIn(dir, "rev-parse", "HEAD");
    gitIn(dir, "update-ref", "refs/remotes/origin/main", base);
    gitIn(dir, "reset", "-q", "--hard", "HEAD~1");
    return { head: gitIn(dir, "rev-parse", "HEAD"), base };
  }

  const scores120 = async (dir: string) =>
    stubTool(
      `mkdir -p "${path.join(dir, ".metrics")}"; echo '{:name "f", :namespace "a", :complexity 5, :coverage 0.0, :crap 120.0}' > "${path.join(dir, ".metrics", "crap.edn")}"`,
    );

  it("refuses a tree that is behind the commit it would become", async () => {
    const { stableBaseline } = await import("../scripts/ub-quality-gate.mjs");
    const dir = await mkdtemp(path.join(tmpdir(), "agent-team-base-behind-"));
    const { head, base } = await behindTree(dir);
    const tool = await scores120(dir);
    const messages: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      messages.push(String(chunk));
      return true;
    });
    const options = parseArgs(["--update-baseline", "--baseline", "base.json"], {});
    expect(stableBaseline(tool, options, dir)).toBe(1);
    stderr.mockRestore();
    const printed = messages.join("");
    expect(printed).toContain("refusing to write");
    expect(printed).toContain(head);
    expect(printed).toContain(base);
    expect(printed.toLowerCase()).toContain("measure the tree that will become main");
    expect(existsSync(path.join(dir, "base.json"))).toBe(false);
    // Refused before spending a scan: the cheap check runs first.
    expect(existsSync(path.join(dir, ".metrics", "crap.edn"))).toBe(false);
  });

  it("refuses instead of assuming when origin/main cannot be resolved", async () => {
    const { stableBaseline } = await import("../scripts/ub-quality-gate.mjs");
    const dir = await mkdtemp(path.join(tmpdir(), "agent-team-base-missing-"));
    gitIn(dir, "init", "-q", "-b", "main");
    gitIn(dir, "-c", "user.email=gate@example.com", "-c", "user.name=gate", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "fixture");
    const tool = await scores120(dir);
    const messages: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      messages.push(String(chunk));
      return true;
    });
    const options = parseArgs(["--update-baseline", "--baseline", "base.json"], {});
    expect(stableBaseline(tool, options, dir)).toBe(1);
    stderr.mockRestore();
    // Silent success here would be the same accident in a new costume.
    expect(messages.join("")).toContain("--expect-base");
    expect(existsSync(path.join(dir, "base.json"))).toBe(false);
  });

  it("accepts a base the operator declares by hand", async () => {
    const { stableBaseline } = await import("../scripts/ub-quality-gate.mjs");
    const dir = await mkdtemp(path.join(tmpdir(), "agent-team-base-declared-"));
    const { head } = await behindTree(dir);
    const tool = await scores120(dir);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const options = parseArgs(["--update-baseline", "--baseline", "base.json", "--expect-base", head], {});
    expect(stableBaseline(tool, options, dir)).toBe(0);
    stdout.mockRestore();
    expect(JSON.parse(await readFile(path.join(dir, "base.json"), "utf8")).scores).toEqual({ "a#f": 120 });
  });

  it("still refuses when the declared base disagrees with the tree", async () => {
    const { stableBaseline } = await import("../scripts/ub-quality-gate.mjs");
    const dir = await mkdtemp(path.join(tmpdir(), "agent-team-base-wrong-"));
    const { base } = await behindTree(dir);
    const tool = await scores120(dir);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const options = parseArgs(["--update-baseline", "--baseline", "base.json", "--expect-base", base], {});
    expect(stableBaseline(tool, options, dir)).toBe(1);
    stderr.mockRestore();
    expect(existsSync(path.join(dir, "base.json"))).toBe(false);
  });
});

describe("tool commit", () => {
  it("prefers a declared commit over reading the checkout", async () => {
    const { toolCommit } = await import("../scripts/ub-quality-gate.mjs");
    expect(toolCommit("/nonexistent/ub", { UB_TOOL_COMMIT: " 6fd92c4 " })).toBe("6fd92c4");
    // No declaration and no checkout: undefined rather than a guess.
    expect(toolCommit("/nonexistent/ub", {})).toBeUndefined();
  });
});

describe("the coverage pair has a flag dependency", () => {
  it("refuses a pair given without --use-existing-coverage", async () => {
    const { stableBaseline } = await import("../scripts/ub-quality-gate.mjs");
    const dir = await mkdtemp(path.join(tmpdir(), "agent-team-pair-flag-"));
    await mainTree(dir);
    await mkdir(path.join(dir, "a"), { recursive: true });
    await mkdir(path.join(dir, "b"), { recursive: true });
    await writeFile(path.join(dir, "a", "lcov.info"), "SF:src/a.ts\nDA:1,1\n", "utf8");
    await writeFile(path.join(dir, "b", "lcov.info"), "SF:src/a.ts\nDA:1,1\n", "utf8");
    const tool = await stubTool("exit 0");
    // No `-- --use-existing-coverage`: the gate would silently regenerate coverage and
    // ignore the pair, then call the result a reproducible refresh.
    const options = parseArgs(
      ["--update-baseline", "--baseline", "base.json", "--coverage-a", "a/lcov.info", "--coverage-b", "b/lcov.info"],
      {},
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(stableBaseline(tool, options, dir)).toBe(1);
    const printed = stderr.mock.calls.map((call) => String(call[0])).join("");
    stderr.mockRestore();
    expect(printed).toContain("--use-existing-coverage");
    expect(printed).toContain("--coverage-a A --coverage-b B -- --use-existing-coverage");
    expect(existsSync(path.join(dir, "base.json"))).toBe(false);
  });
});

describe("refresh from three merged coverage runs", () => {
  const sample = (hits: number) => `SF:src/a.ts\nDA:1,${hits}\nLF:1\nLH:${hits > 0 ? 1 : 0}\nend_of_record\n`;

  async function fixture(hits: [number, number, number]) {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-team-merge-"));
    await mainTree(dir);
    for (const [index, value] of hits.entries()) {
      const name = ["a", "b", "c"][index]!;
      await mkdir(path.join(dir, name), { recursive: true });
      await writeFile(path.join(dir, name, "lcov.info"), sample(value), "utf8");
    }
    const options = parseArgs(
      [
        "--update-baseline",
        "--baseline",
        "base.json",
        "--coverage-a",
        "a/lcov.info",
        "--coverage-b",
        "b/lcov.info",
        "--coverage-c",
        "c/lcov.info",
        "--",
        "--use-existing-coverage",
      ],
      {},
    );
    const tool = await stubTool(
      `mkdir -p "${path.join(dir, ".metrics")}"; echo '{:name "f", :namespace "a", :complexity 5, :coverage 0.0, :crap 120.0}' > "${path.join(dir, ".metrics", "crap.edn")}"`,
    );
    return { dir, options, tool };
  }

  it("writes a baseline from the merged lines and records how it was merged", async () => {
    const { stableBaseline } = await import("../scripts/ub-quality-gate.mjs");
    const { dir, options, tool } = await fixture([1, 1, 0]);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(stableBaseline(tool, options, dir)).toBe(0);
    stdout.mockRestore();
    stderr.mockRestore();
    const written = JSON.parse(await readFile(path.join(dir, "base.json"), "utf8"));
    expect(written.generation.merge).toMatchObject({ runs: 3, rule: "line-majority", divergentLines: 1 });
    expect(written.generation.merge.digests).toHaveLength(3);
  });

  it("counts a line covered by one of three runs as uncovered", async () => {
    const { stableBaseline, requireReproducibleCoverage } = await import("../scripts/ub-quality-gate.mjs");
    const { dir, options } = await fixture([1, 0, 0]);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // The return is a union: the merge summary only exists when the scan ran.
    // `toMatchObject` states the expectation without pretending the field is
    // always there, which is what `?.` would have done.
    expect(requireReproducibleCoverage(options, dir)).toMatchObject({
      merge: { divergentLines: 1 },
    });
    stderr.mockRestore();
    const merged = await readFile(path.join(dir, "target", "coverage", "typescript", "lcov.info"), "utf8");
    expect(merged).toContain("DA:1,0");
    void stableBaseline;
  });
});

describe("the complexity census", () => {
  /** One EDN entry in the shape crapper writes. */
  const entry = (namespace: string, name: string, complexity: number) =>
    `{:name "${name}", :namespace "${namespace}", :complexity ${complexity}, ` +
    `:coverage 100.0, :crap ${complexity}}`;

  /** A stub tool that answers the scan with the given entries, and a tree that could be main. */
  async function censusTree(entries: string[]) {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-census-"));
    await mainTree(root);
    const tool = await stubTool(
      [
        'mkdir -p "$PWD/.metrics"',
        `cat > "$PWD/.metrics/crap.edn" <<'EDN'`,
        "{:entries [",
        entries.join("\n"),
        "]}",
        "EDN",
      ].join("\n"),
    );
    return { root, tool };
  }

  it("records what the scan measured, sorted, and counts the ones over the allowance", async () => {
    // The census is what the newcomer rule reads, so its shape is the rule's input:
    // a key per `namespace#function`, a complexity per key, and a histogram that makes
    // the distribution readable without walking 3,800 lines.
    const { writeCcSnapshot, defaultOptions } = await import("../scripts/ub-quality-gate.mjs");
    const { root, tool } = await censusTree([entry("mod", "b", 6), entry("mod", "a", 2)]);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    expect(writeCcSnapshot(tool, { ...defaultOptions(), ccBaseline: "census.json" }, root)).toBe(0);

    stdout.mockRestore();
    expect(JSON.parse(await readFile(path.join(root, "census.json"), "utf8"))).toEqual({
      total: 2,
      byComplexity: { "2": 1, "6": 1 },
      counts: { "mod#a": 2, "mod#b": 6 },
    });
  });

  it("refuses a tree that is not the commit which becomes main", async () => {
    // Freezing from a side branch records debt that is already paid as if it were current:
    // #198 froze 7 such entries, #206 froze 3. The refusal is the whole point of the function.
    const { writeCcSnapshot, defaultOptions } = await import("../scripts/ub-quality-gate.mjs");
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-census-side-"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(writeCcSnapshot("/bin/true", { ...defaultOptions(), ccBaseline: "census.json" }, root)).toBe(1);

    stderr.mockRestore();
    expect(existsSync(path.join(root, "census.json"))).toBe(false);
  });

  it("returns the tool's failure instead of writing a census from a broken scan", async () => {
    const { writeCcSnapshot, defaultOptions } = await import("../scripts/ub-quality-gate.mjs");
    const { root } = await censusTree([]);
    const broken = await stubTool("exit 1");

    expect(writeCcSnapshot(broken, { ...defaultOptions(), ccBaseline: "census.json" }, root)).toBe(1);
  });
});
