import { describe, expect, it } from "vitest";
import config from "../vitest.config.js";

/**
 * Coverage is collected for every file in the project, so anything that is not a
 * source must be excluded explicitly. `target/coverage/**` used to be collected:
 * its own html assets were instrumented as untested sources, and a second run
 * that cleared that directory killed the first with
 * `ENOENT ... lcov-report/sorter.js` inside `V8ToIstanbul.load`. The gate then
 * read a crashed run as 0% coverage, which is worse than a red test.
 */
describe("coverage configuration", () => {
  const coverage = config.test?.coverage;

  it("keeps build output out of the instrumented source set", () => {
    expect(coverage?.exclude).toEqual(expect.arrayContaining(["target/**", "coverage/**"]));
  });

  it("writes reports outside the tree it scans for sources", () => {
    expect(coverage?.reportsDirectory).toBe("target/coverage/typescript");
    const excluded = coverage?.exclude ?? [];
    expect(excluded).toContain("target/**");
  });
});
