import { describe, expect, it } from "vitest";
import {
  REPEATS,
  attributionPlan,
  buildAttribution,
  caliberOptions,
  keyPattern,
  main,
  parseArgs,
  renderAttribution,
} from "../scripts/coverage-caliber-attribution.mjs";
import { buildReport } from "../scripts/coverage-caliber-report.mjs";

const LCOV = "/repo/target/coverage/typescript/lcov.info";
const METRICS = "/repo/.metrics/crap.edn";

/** A crap.edn holding one function at the given score. */
function crapEdn(score: number, key = "a#k"): string {
  const [namespace, name] = key.split("#");
  return `{:name "${name}", :namespace "${namespace}", :line 1, :crap ${score}}\n`;
}

/**
 * The process boundary from #197, faked: a run "produces" coverage, scoring reads whatever
 * the next entry says. Enough to drive the whole flow without launching vitest once.
 */
function memoryIO(scores: string[]) {
  const files = new Map<string, string>();
  const commands: string[][] = [];
  let scored = 0;
  return {
    files,
    commands,
    io: {
      cwd: "/repo",
      read: (file: string) => {
        const text = files.get(file);
        if (text === undefined) throw new Error(`ENOENT ${file}`);
        return text;
      },
      write: (file: string, text: string) => void files.set(file, text),
      copy: (from: string, to: string) => void files.set(to, files.get(from) ?? ""),
      exists: (file: string) => files.has(file),
      mkdirp: () => {},
      run: (command: string, args: string[]) => {
        commands.push([command, ...args]);
        files.set(LCOV, "SF:src/a.ts\nDA:1,1\nend_of_record\n");
      },
      runTool: (command: string, args: string[]) => {
        commands.push([command, ...args]);
        files.set(METRICS, scores[Math.min(scored, scores.length - 1)]);
        scored += 1;
        return { status: 2 };
      },
    },
  };
}

const ledgerWithNew = (key = "a#k", score = 20) => ({
  kind: "ledger",
  counts: { new: 1, worse: 0, fixed: 0 },
  new: [{ key, score }],
  worse: [],
  fixed: [],
});

describe("coverage caliber attribution", () => {
  it("only runs when the ledger reported new debt", () => {
    expect(attributionPlan(ledgerWithNew())).toEqual({ run: true, keys: ["a#k"] });
  });

  it("stays quiet when the scan itself broke", () => {
    const plan = attributionPlan({ kind: "infrastructure", error: "no coverage report" });
    expect(plan.run).toBe(false);
    expect(plan.reason).toContain("扫描本身没跑完");
  });

  it("stays quiet when nothing was new, even if debt was paid or moved", () => {
    const paid = { kind: "ledger", counts: { new: 0, worse: 2, fixed: 5 }, new: [], worse: [], fixed: [] };
    expect(attributionPlan(paid).run).toBe(false);
  });

  it("measures only the new keys, whatever characters they contain", () => {
    const cells = [
      { commit: "HEAD", mode: "existing", scores: new Map([["a#b(1).c", 20], ["a#b_1_.c", 20], ["z#other", 20]]) },
    ];
    const rows = buildReport(cells, { keys: keyPattern(["a#b(1).c"]) }).rows;
    expect(rows.map((row) => row.key)).toEqual(["a#b(1).c"]);
  });

  it("uses three repeats of the caliber the ledger reads", () => {
    const options = caliberOptions({ run: true, keys: ["a#k"] }, "/tmp/ub");
    expect(options).toMatchObject({ repeats: 3, modes: ["existing"], ub: "/tmp/ub" });
    expect(REPEATS).toBe(3);
  });

  it("reports a reproduced score as stable", () => {
    const { io, commands } = memoryIO([crapEdn(20), crapEdn(20), crapEdn(20.1)]);
    const model = buildAttribution(ledgerWithNew(), "/tmp/ub", io);
    expect(model.status).toBe("measured");
    expect(model.rows).toEqual([
      { key: "a#k", ledger: 20, perCommit: { HEAD: { existing: [20, 20, 20.1] } }, verdict: "stable" },
    ]);
    // Three cells means three suite runs: the cost the nightly pays is per cell, not per key.
    expect(commands.filter(([command]) => command === "npx")).toHaveLength(3);
  });

  it("reports a score that moves between runs as run-sensitive", () => {
    const { io } = memoryIO([crapEdn(20), crapEdn(20), crapEdn(40)]);
    const model = buildAttribution(ledgerWithNew("a#k", 20), "/tmp/ub", io);
    expect(model.rows[0].verdict).toBe("run-sensitive");
    expect(renderAttribution(model).join("\n")).toContain("先别把它当债去补测试");
  });

  it("calls a score the repeats agree on but the ledger never saw not-reproduced", () => {
    const { io } = memoryIO([crapEdn(33), crapEdn(33), crapEdn(33.2)]);
    const model = buildAttribution(ledgerWithNew("a#k", 61.5), "/tmp/ub", io);
    expect(model.rows[0].verdict).toBe("not-reproduced");
    expect(model.summary).toMatchObject({ "not-reproduced": 1, stable: 0 });
    expect(renderAttribution(model).join("\n")).toContain("账本这条是采样噪声");
  });

  it("does not run the suite when there is nothing to explain", () => {
    const { io, commands } = memoryIO([crapEdn(20)]);
    const model = buildAttribution({ kind: "ledger", counts: { new: 0, worse: 0, fixed: 3 } }, "/tmp/ub", io);
    expect(model.status).toBe("skipped");
    expect(commands).toEqual([]);
  });

  it("turns a broken measurement into a note instead of a crash", () => {
    const broken = {
      ...memoryIO([crapEdn(20)]).io,
      run: () => {
        throw new Error("npx vitest exited 1");
      },
    };
    const model = buildAttribution(ledgerWithNew(), "/tmp/ub", broken);
    expect(model).toMatchObject({ status: "failed", reason: "npx vitest exited 1" });
  });

  it("says why it could not measure when the tool chain is missing", () => {
    const { io, commands } = memoryIO([crapEdn(20)]);
    expect(buildAttribution(ledgerWithNew(), "", io)).toMatchObject({ status: "failed" });
    expect(commands).toEqual([]);
  });

  it("renders nothing at all for a night with nothing to explain", () => {
    expect(renderAttribution(undefined)).toEqual([]);
    expect(renderAttribution({ status: "skipped", reason: "本轮没有新增债务，不归因" })).toEqual([]);
  });

  it("renders a failed attribution as one line that cannot be mistaken for a verdict", () => {
    const lines = renderAttribution({ status: "failed", reason: "ub-mode tool chain not found" }).join("\n");
    expect(lines).toContain("没能归因");
    expect(lines).toContain("归因只是解释，不是守卫");
  });

  it("writes the artifact and exits 0 even when the measurement failed", () => {
    const { io, files } = memoryIO([crapEdn(20)]);
    files.set("/repo/drift-report.json", JSON.stringify({ ...ledgerWithNew(), kind: "ledger" }));
    const status = main(["/repo/drift-report.json", "/repo/out.json", "--ub", "/tmp/ub"], io);
    expect(status).toBe(0);
    expect(JSON.parse(files.get("/repo/out.json") ?? "{}").status).toBe("measured");
  });

  it("writes a skipped artifact when the report says nothing is new", () => {
    const { io, files, commands } = memoryIO([crapEdn(20)]);
    files.set("/repo/drift-report.json", JSON.stringify({ kind: "ledger", counts: { new: 0, worse: 0, fixed: 0 } }));
    expect(main(["/repo/drift-report.json", "/repo/out.json"], io)).toBe(0);
    expect(JSON.parse(files.get("/repo/out.json") ?? "{}").status).toBe("skipped");
    expect(commands).toEqual([]);
  });

  it("treats a missing drift report as a broken scan, not as new debt", () => {
    const { io, files } = memoryIO([crapEdn(20)]);
    expect(main(["/repo/absent.json", "/repo/out.json"], io)).toBe(0);
    expect(JSON.parse(files.get("/repo/out.json") ?? "{}").status).toBe("skipped");
  });

  it("refuses to run without a report and rejects unknown flags", () => {
    expect(main([], memoryIO([]).io)).toBe(1);
    expect(() => parseArgs(["--nope"], {})).toThrow("unknown argument");
    expect(() => parseArgs(["--ub"], {})).toThrow("--ub requires a value");
    expect(parseArgs([], {})).toMatchObject({ out: "caliber-attribution.json" });
    expect(parseArgs(["a.json"], { UB_BIN: "/tmp/ub" })).toMatchObject({ report: "a.json", ub: "/tmp/ub" });
  });
});
