import { spawnSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Every CLI has to work when it is reached through a path that is not the one the
 * module will report, because that is how it is reached on a machine where the
 * checkout lives under a symlink — `/tmp` on macOS is `/private/tmp`, and a worktree
 * under `/tmp` is the ordinary case here, not an exotic one.
 *
 * The failure this catches has no other symptom: the entry block is skipped, the
 * process exits 0, and nothing is printed. "Exit 0 and said nothing" is false for
 * every CLI in this repository, which is what makes it a usable assertion.
 *
 * One assertion per CLI is enough. The unit case in `is-main-module.test.ts` pins
 * the comparison itself; this file pins the wiring — that each script asks the
 * question at all, and that the answer survives a symlinked path.
 */

/** The CLIs with an invocation that is both cheap and free of side effects. */
const clis = [
  {
    script: "test-casts-report.mjs",
    args: ["--check"],
    says: /type-escape cast\(s\), none added/,
  },
  {
    script: "test-name-collisions.mjs",
    args: ["--check"],
    says: /confusable name\(s\), 0 new/,
  },
  {
    script: "test-types-report.mjs",
    args: ["--check"],
    says: /test type error\(s\) in \d+ file\(s\), none added/,
  },
  {
    script: "ub-quality-gate.mjs",
    args: ["--help"],
    says: /usage: node scripts\/ub-quality-gate\.mjs/,
  },
  {
    script: "coverage-caliber-report.mjs",
    args: ["--help"],
    says: /usage: node scripts\/coverage-caliber-report\.mjs/,
  },
  {
    script: "coverage-caliber-attribution.mjs",
    args: ["--help"],
    says: /usage: node scripts\/coverage-caliber-attribution\.mjs/,
  },
];

/**
 * Two CLIs are deliberately absent, and the reason is the same for both: neither
 * has an invocation that is cheap and side-effect free. `prepare-desktop-runtime`
 * starts fetching a Node distribution before it reads a flag, and
 * `coverage-drift-issue` queries GitHub before it parses one. They are covered by
 * the static check below, which is the part that has to hold for a new script too.
 */

/** The two forms that were copied around this repository before `lib/is-main-module.mjs`. */
const forbidden = [/import\.meta\.url ===/, /process\.argv\[1\]\.endsWith\(/];

/**
 * Source without its comments. A guard that is commented out is not a guard, and the
 * rule itself is written down in prose in `lib/is-main-module.mjs` — the one place that
 * is allowed to spell the old form, because it is explaining why it is wrong.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("every CLI survives a symlinked path", () => {
  let linked: string;

  beforeAll(async () => {
    const holder = await mkdtemp(path.join(tmpdir(), "cli-entry-"));
    linked = path.join(holder, "checkout");
    // A second name for the same tree, spelled differently — which is all a symlink
    // has to be to break a string comparison.
    symlinkSync(process.cwd(), linked);
  }, 30_000);

  it("still runs, and still says what it always says", () => {
    for (const { script, args, says } of clis) {
      const run = spawnSync(process.execPath, [path.join(linked, "scripts", script), ...args], {
        encoding: "utf8",
      });
      // The name is in the assertion so a failure says which CLI, not which index.
      expect(`${script}: ${run.status}`).toBe(`${script}: 0`);
      expect(run.stdout).toMatch(says);
    }
  }, 120_000);

  it("leaves the two string comparisons nowhere in the tree", async () => {
    // The unit case proves the comparison is right; this one proves nobody wrote their
    // own. A script added next month is checked here without anyone remembering to add it.
    const entries = await readdir("scripts", { recursive: true });
    const offenders = [];
    for (const entry of entries) {
      if (!entry.endsWith(".mjs")) continue;
      const code = withoutComments(await readFile(path.join("scripts", entry), "utf8"));
      if (forbidden.some((pattern) => pattern.test(code))) offenders.push(entry);
    }
    expect(offenders).toEqual([]);
  });
});
