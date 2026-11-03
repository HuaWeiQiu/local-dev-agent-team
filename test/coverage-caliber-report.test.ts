import { describe, expect, it, vi } from "vitest";
import {
  buildReport,
  classifyKey,
  coverageSignature,
  main,
  parseArgs,
  renderMarkdown,
  summarize,
} from "../scripts/coverage-caliber-report.mjs";

describe("coverage caliber report", () => {
  it("defaults to 8 repeats of both modes", () => {
    const options = parseArgs([], {});
    expect(options).toMatchObject({ repeats: 8, modes: ["self", "existing"], format: "md" });
  });

  it("signs the covered lines, not the hit counts", () => {
    const a = "SF:src/a.ts\nDA:1,9\nDA:2,0\nend_of_record\n";
    const b = "SF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n";
    const c = "SF:src/a.ts\nDA:1,9\nDA:2,1\nend_of_record\n";
    expect(coverageSignature(a)).toBe(coverageSignature(b));
    expect(coverageSignature(a)).not.toBe(coverageSignature(c));
  });

  it("classifies stable, run-sensitive and source-sensitive", () => {
    const base = { self: [20, 20.1], existing: [20, 20] };
    expect(classifyKey({ commitA: base, modes: base })).toBe("stable");

    const noisy = { self: [20, 40], existing: [20, 20] };
    expect(classifyKey({ commitA: noisy, modes: noisy })).toBe("run-sensitive");

    const source = { self: [20, 20], existing: [30, 30] };
    expect(classifyKey({ commitA: source, modes: source })).toBe("source-sensitive");
  });

  it("classifies a move between commits as code-changed", () => {
    const a = { self: [20, 20] };
    const b = { self: [30, 30] };
    expect(classifyKey({ commitA: a, commitB: b, modes: a })).toBe("code-changed");
  });

  it("builds a report that renders the same bytes twice", () => {
    const cells = [
      { commit: "a", mode: "self", scores: new Map([["k#x", 20]]) },
      { commit: "a", mode: "self", scores: new Map([["k#x", 20.2]]) },
      { commit: "a", mode: "existing", scores: new Map([["k#x", 31]]) },
    ];
    const report = buildReport(cells, { keys: "^k#" });
    expect(report.rows.map((row) => row.key)).toEqual(["k#x"]);
    expect(renderMarkdown(report)).toBe(renderMarkdown(buildReport(cells, { keys: "^k#" })));
    expect(summarize(report)).toMatchObject({ "source-sensitive": 1 });
  });

  it("filters keys with a regex", () => {
    const cells = [
      { commit: "a", mode: "self", scores: new Map([["k#keep", 20], ["other#drop", 20]]) },
    ];
    expect(buildReport(cells, { keys: "keep" }).rows.map((row) => row.key)).toEqual(["k#keep"]);
  });

  it("passes its own self-check", () => {
    const stdout: string[] = [];
    const write = (chunk: string) => {
      stdout.push(chunk);
      return true;
    };
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = write as typeof process.stdout.write;
    const status = main(["--self-check"]);
    process.stdout.write = original;
    expect(status).toBe(0);
    expect(stdout.join("")).toContain("self-check ok");
  });
});

describe("caliber flow, driven through an injected io", () => {
  /** An io that pretends to measure: it writes a report and a metrics file. */
  function fakeIO(overrides: { existing?: () => string; metrics?: string } = {}) {
    const files = new Map<string, string>();
    const cwd = "/tmp/caliber-fake";
    const io = {
      cwd,
      read: (file: string) => files.get(file) ?? "",
      write: (file: string, text: string) => void files.set(file, text),
      copy: (from: string, to: string) => void files.set(to, files.get(from) ?? ""),
      exists: (file: string) => files.has(file),
      mkdirp: () => undefined,
      run: () => undefined,
      runTool: () => ({ status: 0 }),
    };
    const produced = overrides.existing?.() ?? "SF:src/a.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n";
    files.set(`${cwd}/target/coverage/typescript/lcov.info`, produced);
    files.set(
      `${cwd}/.metrics/crap.edn`,
      overrides.metrics ?? '{:name "f", :namespace "a", :complexity 5, :coverage 100.0, :crap 5.0}\n',
    );
    return { io, files };
  }

  it("measures one cell per commit, mode and repeat", async () => {
    const { measureCells } = await import("../scripts/coverage-caliber-report.mjs");
    const { io, files } = fakeIO();
    const options = { ...parseArgs(["--repeats", "2", "--modes", "existing"], {}), commits: ["HEAD"] };
    const cells = measureCells(options, io as never);
    expect(cells).toHaveLength(2);
    expect(cells[0]).toMatchObject({ commit: "HEAD", mode: "existing" });
    expect(cells[0]!.scores.get("a#f")).toBe(5);
    expect(files.has("/tmp/caliber-fake/target/coverage/caliber/HEAD/existing/run-2/lcov.info")).toBe(true);
  });

  it("keeps both reports when two runs covered different lines", async () => {
    const { keepIfDivergent } = await import("../scripts/coverage-caliber-report.mjs");
    const root = "/tmp/caliber-fake/target/coverage/caliber";
    const files = new Map<string, string>([
      [`${root}/HEAD/existing/run-1/lcov.info`, "SF:src/a.ts\nDA:1,1\nend_of_record\n"],
      [`${root}/HEAD/existing/run-2/lcov.info`, "SF:src/a.ts\nDA:1,0\nend_of_record\n"],
    ]);
    const io = {
      cwd: "/tmp/caliber-fake",
      read: (file: string) => files.get(file) ?? "",
      write: (file: string, text: string) => void files.set(file, text),
      copy: (from: string, to: string) => void files.set(to, files.get(from) ?? ""),
      exists: (file: string) => files.has(file),
      mkdirp: () => undefined,
      run: () => undefined,
      runTool: () => ({ status: 0 }),
    };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const kept = keepIfDivergent(root, "HEAD", "existing", `${root}/HEAD/existing/run-2`, 2, io as never);
    stderr.mockRestore();
    expect(kept).toContain("unstable");
    expect(files.has(`${root}/HEAD/existing/unstable/run-1.lcov.info`)).toBe(true);
    expect(files.has(`${root}/HEAD/existing/unstable/run-2.lcov.info`)).toBe(true);
  });

  it("writes the report through main and reports measurement failure", async () => {
    const { main } = await import("../scripts/coverage-caliber-report.mjs");
    const { io } = fakeIO();
    const out: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    const code = main(["--repeats", "1", "--modes", "existing", "--format", "json", "--ub", "/fake/ub"], io as never);
    stdout.mockRestore();
    expect(code).toBe(0);
    expect(out.join("")).toContain('"rows"');

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const missing = main(["--repeats", "1", "--modes", "existing"], { ...io, exists: () => false } as never);
    stderr.mockRestore();
    expect(missing).toBe(1);
  });

  it("rejects an unknown flag without touching the io", () => {
    const out: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    const code = main(["--nope"]);
    stderr.mockRestore();
    expect(code).toBe(1);
    expect(out.join("")).toContain("unknown argument");
  });
});

describe("self-check judging", () => {
  it("accepts a report that gets all three verdicts right and renders twice the same", async () => {
    const { selfCheckCells, selfCheckProblems, buildReport, renderMarkdown } = await import(
      "../scripts/coverage-caliber-report.mjs"
    );
    const report = buildReport(selfCheckCells());
    const once = renderMarkdown(report);
    expect(selfCheckProblems(report, once, renderMarkdown(buildReport(selfCheckCells())))).toEqual([]);
  });

  it("names what a broken fixture got wrong", async () => {
    const { selfCheckProblems } = await import("../scripts/coverage-caliber-report.mjs");
    const report = {
      rows: [
        { key: "k#stable", verdict: "run-sensitive", perCommit: {} },
        { key: "k#noisy", verdict: "run-sensitive", perCommit: {} },
        { key: "k#source", verdict: "stable", perCommit: {} },
      ],
    };
    const problems = selfCheckProblems(report, "a", "b");
    expect(problems).toHaveLength(3);
    expect(problems.join(" ")).toContain("stable 判成 run-sensitive");
    expect(problems.join(" ")).toContain("source-sensitive 判成 stable");
    expect(problems.join(" ")).toContain("连跑两次报告不一致");
  });
});
