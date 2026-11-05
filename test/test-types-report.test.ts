import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import {
  compareToBaseline,
  countByFile,
  decodeAllowance,
  fileViolations,
  formatReport,
  formatViolations,
  freezeBaseline,
  isBaseline,
  loadBaseline,
  option,
  parseDiagnostics,
  readAllowances,
  run,
  runTsc,
  sumCounts,
  totalViolation,
  unpositionedErrors,
} from "../scripts/test-types-report.mjs";

/** The three errors the probe project below produces, as `a.ts` then `b.ts`. */
const compilerOutput = [
  "test/a.test.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  "  Types of property 'x' are incompatible.",
  "test/a.test.ts(9,1): error TS2345: Argument of type 'string' is not assignable.",
  "test/b.test.ts(1,1): error TS2739: Type '{}' is missing the following properties.",
].join("\n");

type Counts = Record<string, number>;
type Frozen = { total: number; counts: Counts; allowedIncreases?: Counts | Record<string, string> };

describe("reading what the compiler printed", () => {
  it("takes positioned diagnostics and ignores continuation lines", () => {
    const found = parseDiagnostics(compilerOutput);
    expect(found).toHaveLength(3);
    expect(found[1]).toEqual({ file: "test/a.test.ts", line: 9, code: "TS2345" });
  });

  it("counts per file, because lines move and files do not", () => {
    expect(countByFile(parseDiagnostics(compilerOutput))).toEqual({
      "test/a.test.ts": 2,
      "test/b.test.ts": 1,
    });
  });

  it("separates errors that belong to no source file", () => {
    // A broken tsconfig checks nothing. Parsed as zero errors it would read as a
    // clean run, which is the one failure that makes this gate worse than none.
    const broken = "error TS18003: No inputs were found in config file: 'tsconfig.test.json'.";
    expect(unpositionedErrors(broken)).toHaveLength(1);
    expect(unpositionedErrors(compilerOutput)).toEqual([]);
  });

  it("sums the counts it was given", () => {
    expect(sumCounts({ a: 2, b: 1 })).toBe(3);
    expect(sumCounts({})).toBe(0);
  });
});

describe("the three rules", () => {
  const baseline = { total: 3, counts: { "test/a.test.ts": 2, "test/b.test.ts": 1 } };

  it("rule 1: refuses more errors in total", () => {
    expect(totalViolation(3, baseline)).toEqual([]);
    expect(totalViolation(4, baseline)).toEqual([
      { kind: "total", key: "total", allowed: 3, count: 4 },
    ]);
  });

  it("rule 2: refuses a file that grew, even when the total did not", () => {
    const grown = { "test/a.test.ts": 3, "test/b.test.ts": 0 };
    expect(fileViolations(grown, baseline)).toEqual([
      { kind: "file", key: "test/a.test.ts", allowed: 2, count: 3 },
    ]);
  });

  it("rule 3: refuses a file the baseline has never seen", () => {
    const fresh = fileViolations({ "test/new.test.ts": 30 }, baseline);
    expect(fresh).toEqual([
      { kind: "new-file", key: "test/new.test.ts", allowed: 0, count: 30 },
    ]);
  });

  it("reports both rules when both are broken", () => {
    const diagnostics = parseDiagnostics(compilerOutput);
    const violations = compareToBaseline(diagnostics, { total: 1, counts: {} });
    expect(violations.map((violation) => violation.kind)).toEqual(["total", "new-file", "new-file"]);
  });
});

describe("moving the baseline", () => {
  const previous = { total: 3, counts: { "test/a.test.ts": 2, "test/b.test.ts": 1 } };

  it("lets every file fall", () => {
    const { baseline, rejected } = freezeBaseline(previous, { "test/a.test.ts": 1 }, {});
    expect(rejected).toEqual([]);
    expect(baseline).toEqual({ total: 1, counts: { "test/a.test.ts": 1 }, allowedIncreases: {} });
  });

  it("refuses a rise that nobody named", () => {
    const { baseline, rejected } = freezeBaseline(previous, { "test/a.test.ts": 3 }, {});
    expect(rejected).toEqual([{ file: "test/a.test.ts", before: 2, count: 3 }]);
    expect(baseline.total).toBe(0);
  });

  it("writes the reason into the baseline when one is given", () => {
    const { baseline, rejected } = freezeBaseline(previous, { "test/a.test.ts": 3 }, { "test/a.test.ts": "one more" });
    expect(rejected).toEqual([]);
    expect(baseline.allowedIncreases).toEqual({ "test/a.test.ts": "one more" });
  });

  it("carries a reason forward while its number stands, and drops it when the number falls", () => {
    const raised = { total: 3, counts: { "test/a.test.ts": 3 }, allowedIncreases: { "test/a.test.ts": "why" } };
    expect(freezeBaseline(raised, { "test/a.test.ts": 3 }, {}).baseline.allowedIncreases).toEqual({
      "test/a.test.ts": "why",
    });
    expect(freezeBaseline(raised, { "test/a.test.ts": 1 }, {}).baseline.allowedIncreases).toEqual({});
  });

  it("does not reuse a reason for a further rise", () => {
    const raised = { total: 3, counts: { "test/a.test.ts": 3 }, allowedIncreases: { "test/a.test.ts": "why" } };
    const { rejected } = freezeBaseline(raised, { "test/a.test.ts": 4 }, {});
    expect(rejected).toHaveLength(1);
  });
});

describe("reading the allowance off the command line", () => {
  it("splits at the first comma, so a reason may contain commas", () => {
    expect(decodeAllowance("--allow-increase=test/a.test.ts,fixed by hand, then reviewed")).toEqual({
      file: "test/a.test.ts",
      reason: "fixed by hand, then reviewed",
    });
  });

  it("reads a plain pair", () => {
    expect(decodeAllowance("--allow-increase=test/a.test.ts,a reason")).toEqual({
      file: "test/a.test.ts",
      reason: "a reason",
    });
  });

  it("refuses an allowance with no reason", () => {
    expect(() => readAllowances(["--allow-increase=test/a.test.ts"])).toThrow(/needs a reason/);
    expect(() => readAllowances(["--update-baseline"])).not.toThrow();
  });
});

describe("a baseline that cannot be read", () => {
  it("recognises the shape it needs", () => {
    expect(isBaseline({ total: 1, counts: {} })).toBe(true);
    expect(isBaseline({ total: 1 })).toBe(false);
    expect(isBaseline({ counts: {} })).toBe(false);
    expect(isBaseline(null)).toBe(false);
    expect(isBaseline("1")).toBe(false);
  });

  it("says which file is missing rather than crashing", async () => {
    const missing = path.join(await mkdtemp(path.join(tmpdir(), "baseline-")), "absent.json");
    expect(() => loadBaseline(missing)).toThrow(/No baseline at .*absent\.json/);
  });

  it("names the shape it wanted when the file holds something else", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "baseline-"));
    const wrong = path.join(root, "wrong.json");
    await writeFile(wrong, JSON.stringify({ known: [] }));
    expect(() => loadBaseline(wrong)).toThrow(/is not a baseline/);
  });
});

describe("what a person reads", () => {
  const diagnostics = parseDiagnostics(compilerOutput);

  it("reports totals by code and by file", () => {
    const report = formatReport(diagnostics);
    expect(report).toContain("3 test type error(s) in 2 file(s)");
    expect(report).toContain("TS2322");
    expect(report).toContain("test/a.test.ts");
  });

  it("explains each violation in the words of the rule it broke", () => {
    const baseline = { total: 1, counts: {} };
    const text = formatViolations(compareToBaseline(diagnostics, baseline), diagnostics, baseline);
    expect(text).toContain("total: 1 -> 3");
    expect(text).toContain("test/a.test.ts: 0 -> 2 (new file: absent from the baseline)");
    expect(text).toContain("test/a.test.ts:3 TS2322");
  });

  it("points out a baseline that disagrees with itself", () => {
    const baseline = { total: 2, counts: { "test/a.test.ts": 2, "test/b.test.ts": 1 } };
    const text = formatViolations([{ kind: "total", key: "total", allowed: 2, count: 3 }], diagnostics, baseline);
    expect(text).toContain("the baseline disagrees with itself");
  });
});

describe("the command line", () => {
  const script = fileURLToPath(new URL("../scripts/test-types-report.mjs", import.meta.url));
  const exec = promisify(execFile);

  async function runScript(args: string[]) {
    try {
      const { stdout, stderr } = await exec(process.execPath, [script, ...args]);
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
  }

  /** A project whose two files produce exactly three errors: `a.ts` two, `b.ts` one. */
  async function probeProject(files: Record<string, string>) {
    const root = await mkdtemp(path.join(tmpdir(), "types-gate-"));
    const compilerOptions = { strict: true, noEmit: true, target: "ES2022", module: "ESNext" };
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions, include: ["*.ts"] }),
    );
    for (const [name, text] of Object.entries(files)) {
      await writeFile(path.join(root, name), text);
    }
    return root;
  }

  let project: string;

  beforeAll(async () => {
    project = await probeProject({
      "a.ts": 'export const a: number = "one";\nexport const b: string = 2;\n',
      "b.ts": "export const c: boolean = 3;\n",
    });
  }, 60_000);

  it("passes the repository's own test project against its own baseline", async () => {
    // The wiring end to end: the compiler runs, the parser reads it, the frozen
    // list agrees, and the process leaves zero.
    const result = await runScript(["--check"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^\d+ test type error\(s\) in \d+ file\(s\), none added$/m);
  }, 60_000);

  it("exits 1 and names the file when a new test file brings errors", async () => {
    const fresh = await probeProject({ "a.ts": 'export const a: number = "one";' });
    const baselinePath = path.join(fresh, "baseline.json");
    await writeFile(baselinePath, JSON.stringify({ total: 0, counts: {} }));
    const result = await runScript([
      "--project",
      path.join(fresh, "tsconfig.json"),
      "--baseline",
      baselinePath,
      "--check",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("(new file: absent from the baseline)");
    expect(result.stderr).toContain("a.ts: 0 -> 1");
  }, 60_000);

  it("exits 1 when the compiler checked nothing at all", async () => {
    const empty = await probeProject({});
    const result = await runScript([
      "--project",
      path.join(empty, "tsconfig.json"),
      "--baseline",
      path.join(empty, "baseline.json"),
      "--check",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("did not type-check");
  }, 30_000);

  // The same modes, called directly. A spawned child has no coverage, and the
  // branches worth pinning are the ones a process cannot be asked about: which
  // baseline a verdict came from, and what a refusal says.
  describe("in this process", () => {
    const diagnostics = parseDiagnostics(compilerOutput);
    const counts: Counts = { "test/a.test.ts": 2, "test/b.test.ts": 1 };

    async function frozenAt(name: string, frozen: Frozen) {
      const target = path.join(project, `${name}.json`);
      await writeFile(target, JSON.stringify(frozen));
      return target;
    }

    it("reads a flag value, and refuses a flag with nothing after it", () => {
      expect(option(["--project", "x.json"], "--project", "d.json")).toBe("x.json");
      expect(option([], "--project", "d.json")).toBe("d.json");
      expect(() => option(["--project"], "--project", "d.json")).toThrow(/needs a value/);
    });

    it("runs the compiler and hands back what it printed", async () => {
      const output = runTsc(path.join(project, "tsconfig.json"), project);
      expect(output).toContain("error TS2322");
    }, 30_000);

    it("throws when the compiler cannot be started at all", () => {
      // A directory that does not exist is the one way spawnSync fails rather
      // than reporting; the message has to be that failure, not "0 errors".
      expect(() => runTsc(path.join(project, "tsconfig.json"), path.join(project, "absent"))).toThrow();
    });

    it("passes when the baseline agrees", async () => {
      const result = run(["--check"], diagnostics, await frozenAt("ok", { total: 3, counts }));
      expect(result.ok).toBe(true);
      expect(result.report).toContain("3 test type error(s) in 2 file(s), none added");
    });

    it("fails rule 2 when one file grew inside the old total", async () => {
      const target = await frozenAt("rule2", { total: 2, counts: { ...counts, "test/a.test.ts": 1 } });
      const result = run(["--check"], diagnostics, target);
      expect(result.ok).toBe(false);
      expect(result.report).toContain("test/a.test.ts: 1 -> 2");
    });

    it("fails rule 3 when the file is new", async () => {
      const result = run(["--check"], diagnostics, await frozenAt("rule3", { total: 1, counts: { "test/b.test.ts": 1 } }));
      expect(result.ok).toBe(false);
      expect(result.report).toContain("(new file: absent from the baseline)");
    });

    it("fails rule 1 when the total was edited below its own counts", async () => {
      const result = run(["--check"], diagnostics, await frozenAt("rule1", { total: 2, counts }));
      expect(result.ok).toBe(false);
      expect(result.report).toContain("total: 2 -> 3");
      expect(result.report).toContain("the baseline disagrees with itself");
    });

    it("reports without a baseline when no mode is asked for", () => {
      const result = run([], diagnostics, path.join(project, "unused.json"));
      expect(result.ok).toBe(true);
      expect(result.report).toContain("by code:");
    });

    it("measures on the first refresh, then refuses a rise and records a named one", async () => {
      const target = path.join(project, "refresh.json");
      const first = run(["--update-baseline"], diagnostics, target);
      expect(first.ok).toBe(true);
      const written = JSON.parse(await readFile(target, "utf8")) as Frozen;
      expect(written.total).toBe(3);

      const grown = [...diagnostics, { file: "test/a.test.ts", line: 20, code: "TS2322" }];
      const refused = run(["--update-baseline"], grown, target);
      expect(refused.ok).toBe(false);
      expect(refused.report).toContain("needs --allow-increase=test/a.test.ts,<reason>");
      expect((JSON.parse(await readFile(target, "utf8")) as { total: number }).total).toBe(3);

      const allowed = run(
        ["--update-baseline", "--allow-increase=test/a.test.ts,one more"],
        grown,
        target,
      );
      expect(allowed.ok).toBe(true);
      const raised = JSON.parse(await readFile(target, "utf8")) as Frozen;
      expect(raised.total).toBe(4);
      expect(raised.allowedIncreases).toEqual({ "test/a.test.ts": "one more" });
    });
  });
});
