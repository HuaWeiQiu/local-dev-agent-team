import { describe, expect, it } from "vitest";
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
