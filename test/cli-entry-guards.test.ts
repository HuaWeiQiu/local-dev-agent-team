import { spawnSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
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

/**
 * The two forms that were copied around this repository before `lib/is-main-module.mjs`,
 * looked for in the syntax tree rather than in the text.
 *
 * Text matching answers "do these bytes look like a guard", which is not the question.
 * It fires on a comment explaining why the form is wrong — `lib/is-main-module.mjs`
 * contains exactly that sentence — and it fires inside a string literal. This repository
 * has already paid for that mistake once: `grep` counted 315 `as never` where the AST
 * counted 291, and six of the sixteen were `was never` in prose.
 */

/**
 * `import.meta.url`, as a node rather than as a substring. `import.meta` parses as a
 * `MetaProperty` — the same shape as `new.target` — not as a property access on an
 * identifier called `import`, which is what a first version assumed.
 */
function isImportMetaUrl(node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false;
  if (node.name.text !== "url") return false;
  const target = node.expression;
  return (
    ts.isMetaProperty(target) &&
    target.keywordToken === ts.SyntaxKind.ImportKeyword &&
    target.name.text === "meta"
  );
}

/** `process.argv[...]`, which is where a hand-rolled entry check reads its input. */
function isArgvElement(node: ts.Node): boolean {
  if (!ts.isElementAccessExpression(node)) return false;
  const target = node.expression;
  return (
    ts.isPropertyAccessExpression(target) &&
    target.name.text === "argv" &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "process"
  );
}

/** Whether a subtree contains a node the predicate accepts. */
function contains(node: ts.Node, predicate: (candidate: ts.Node) => boolean): boolean {
  if (predicate(node)) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && contains(child, predicate)) found = true;
  });
  return found;
}

function isEquality(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.EqualsEqualsEqualsToken || kind === ts.SyntaxKind.EqualsEqualsToken;
}

/** `x.endsWith(...)` called on `process.argv[...]`. */
function isArgvSuffixCheck(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "endsWith" &&
    isArgvElement(callee.expression)
  );
}

/**
 * Every place a file decides its own entry status by comparing strings, as
 * `line: what it did`.
 */
export function stringEntryChecks(source: string, file = "input.mjs"): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && isEquality(node.operatorToken.kind)) {
      const comparesUrl = [node.left, node.right].some((side) => contains(side, isImportMetaUrl));
      if (comparesUrl) found.push(`line ${line(parsed, node)}: compares import.meta.url as a string`);
    }
    if (isArgvSuffixCheck(node)) {
      found.push(`line ${line(parsed, node)}: decides by the tail of process.argv[1]`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

/** @param {ts.SourceFile} file */
function line(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
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

  it("flags the comparison in code, and only in code", () => {
    // The checker has to be proved before its silence means anything: it fires on the
    // form that broke, and stays quiet for the same text in prose and in a string.
    const inCode = 'const main = import.meta.url === pathToFileURL(resolve(argv[1])).href;';
    const inComment = "// we used to write import.meta.url === pathToFileURL(...) here\n";
    const inString = 'const note = "import.meta.url === pathToFileURL(...)";\n';
    const bySuffix = 'const main = process.argv[1].endsWith("some-script.mjs");';

    expect(stringEntryChecks(inCode)).toHaveLength(1);
    expect(stringEntryChecks(bySuffix)).toHaveLength(1);
    expect(stringEntryChecks(inComment)).toEqual([]);
    expect(stringEntryChecks(inString)).toEqual([]);
    expect(stringEntryChecks("export const isMain = isMainModule(import.meta.url, process.argv[1]);"))
      .toEqual([]);
  });

  it("finds no hand-rolled entry check anywhere under scripts/", async () => {
    // The unit case above proves the checker works; this one proves nobody wrote their
    // own. A script added next month is checked here without anyone remembering to add it.
    const entries = await readdir("scripts", { recursive: true });
    const offenders = [];
    for (const entry of entries) {
      if (!entry.endsWith(".mjs")) continue;
      const source = await readFile(path.join("scripts", entry), "utf8");
      for (const hit of stringEntryChecks(source, entry)) offenders.push(`${entry}:${hit}`);
    }
    expect(offenders).toEqual([]);
  });
});
