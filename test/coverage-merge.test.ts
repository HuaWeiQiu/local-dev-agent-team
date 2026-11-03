import { describe, expect, it } from "vitest";
import {
  mergeCoverageReports,
  mergeReports,
  parseLcov,
  serializeLcov,
} from "../scripts/coverage-merge.mjs";

const report = (...lines: Array<[number, number]>) =>
  `SF:src/a.ts\n${lines.map(([n, h]) => `DA:${n},${h}`).join("\n")}\nLF:${lines.length}\nLH:${
    lines.filter(([, h]) => h > 0).length
  }\nend_of_record\n`;

describe("coverage merging", () => {
  it("passes three identical reports through unchanged", () => {
    const text = report([1, 1], [2, 0], [3, 4]);
    const merged = mergeCoverageReports([text, text, text]);
    expect(merged.divergentLines).toBe(0);
    expect(merged.lcov).toContain("DA:1,1");
    expect(merged.lcov).toContain("DA:2,0");
    expect(merged.lcov).toContain("LF:3");
    expect(merged.lcov).toContain("LH:2");
  });

  it("counts a line executed by two of three runs as covered", () => {
    const merged = mergeCoverageReports([report([1, 1]), report([1, 2]), report([1, 0])]);
    expect(merged.divergentLines).toBe(1);
    expect(merged.lcov).toContain("DA:1,1");
  });

  it("counts a line executed by one of three runs as not covered", () => {
    const merged = mergeCoverageReports([report([7, 1]), report([7, 0]), report([7, 0])]);
    expect(merged.divergentLines).toBe(1);
    expect(merged.lcov).toContain("DA:7,0");
  });

  it("keeps a line only one report measured, by its own rule", () => {
    // A single report cannot carry a quorum: the line is uncovered, and the disagreement
    // is visible in the count rather than silently averaged away.
    const merged = mergeCoverageReports([report([9, 1]), report([]), report([])]);
    expect(merged.lcov).toContain("DA:9,0");
    expect(merged.divergentLines).toBe(1);
  });

  it("reports files that only some runs measured", () => {
    const only = "SF:src/b.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n";
    const merged = mergeCoverageReports([report([1, 1]), only, only]);
    expect(merged.partialFiles).toEqual([
      { path: "src/a.ts", presentIn: 1 },
      { path: "src/b.ts", presentIn: 2 },
    ]);
  });

  it("recomputes LF and LH from the merged lines", () => {
    const result = mergeReports([
      parseLcov(report([1, 1], [2, 1])),
      parseLcov(report([1, 1], [2, 0])),
      parseLcov(report([1, 1], [2, 0])),
    ]);
    const text = serializeLcov(result.merged);
    expect(text).toContain("LF:2");
    expect(text).toContain("LH:1");
  });

  it("uses plain majority for five reports", () => {
    const merged = mergeCoverageReports(
      [report([1, 1]), report([1, 1]), report([1, 0]), report([1, 0]), report([1, 0])],
    );
    expect(merged.threshold).toBe(3);
    expect(merged.lcov).toContain("DA:1,0");
  });
});
