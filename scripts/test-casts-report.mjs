#!/usr/bin/env node
/**
 * Report every type-escape cast under `test/`, read from the TypeScript AST.
 *
 * Three forms, counted separately: `as never`, `as any`, and the double cast
 * `as unknown as T`. The last one is the quiet one — it needs no `never`, reads
 * like a necessary widening, and does exactly the same thing: it turns off the
 * check at that expression. A report that tracks only `as never` measures how
 * often we picked that spelling, not how often we bypassed the compiler.
 *
 * Why the compiler and not grep: a text search counts `"...was never promoted"`
 * as a cast (`was never` contains `as never`), counts lines instead of casts so
 * two on one line are one hit, and reports the line `as never` sits on rather
 * than where the expression starts — multi-line fixtures then point at the wrong
 * row when you try to match a table against the file.
 *
 * The parent node is the part grep cannot give: a cast whose parent is an
 * `AssignmentExpression` sits on the right-hand side and never reaches the type
 * check, which is how bucket D is recognised from the tree instead of by
 * deleting the cast and seeing whether the build breaks.
 *
 * The rule the parent enables: a cast's bucket follows its syntactic position,
 * not the words in the enclosing test name. Names are the author's choice;
 * positions are facts.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultBaseline = path.join(defaultRoot, ".test-casts-baseline.json");

/**
 * @typedef {{ path: string, text: string }} Source
 * @typedef {{ file: string, line: number, parent: string, form: "never" | "any" | "unknown-as" }} Cast
 */

/**
 * Every `x as never` in the given sources, in source order.
 * @param {Source[]} sources
 * @returns {Cast[]}
 */
export function collectCasts(sources) {
  const casts = [];
  for (const source of sources) {
    const kind = source.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const file = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true, kind);
    const visit = (node) => {
      const form = castForm(node);
      if (form) {
        casts.push({
          file: source.path,
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
          parent: ts.SyntaxKind[node.parent.kind],
          form,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return casts;
}

/**
 * Which escape a node is, if any. The double cast is the outer expression of
 * `x as unknown as T`: its operand is itself an `as unknown`.
 * @param {import("typescript").Node} node
 * @returns {Cast["form"] | undefined}
 */
function castForm(node) {
  if (!ts.isAsExpression(node)) return undefined;
  if (node.type.kind === ts.SyntaxKind.NeverKeyword) return "never";
  if (node.type.kind === ts.SyntaxKind.AnyKeyword) return "any";
  const inner = node.expression;
  const widening = ts.isAsExpression(inner) && inner.type.kind === ts.SyntaxKind.UnknownKeyword;
  return widening ? "unknown-as" : undefined;
}

/**
 * Casts per file and form. Counting by file rather than by line keeps the
 * comparison stable while edits move lines around; two casts of the same form in
 * one file can still trade places, which is why the total is checked as well.
 * @param {Cast[]} casts
 * @returns {Record<string, number>}
 */
export function countByFileForm(casts) {
  const counts = {};
  for (const cast of casts) {
    const key = `${cast.file}:${cast.form}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Every key that grew relative to the baseline. A key absent from the baseline
 * is allowed only at zero, so a brand new file cannot introduce one.
 * @param {Cast[]} casts
 * @param {{ counts: Record<string, number> }} baseline
 */
export function compareToBaseline(casts, baseline) {
  const now = countByFileForm(casts);
  const violations = [];
  for (const [key, count] of Object.entries(now)) {
    const allowed = baseline.counts[key] ?? 0;
    if (count > allowed) violations.push({ key, allowed, count });
  }
  return violations.sort((left, right) => right.count - left.count);
}

/** @param {Cast[]} casts */
export function summarize(casts) {
  const byParent = {};
  const byFile = {};
  const byForm = {};
  for (const cast of casts) {
    byParent[cast.parent] = (byParent[cast.parent] ?? 0) + 1;
    byFile[cast.file] = (byFile[cast.file] ?? 0) + 1;
    byForm[cast.form] = (byForm[cast.form] ?? 0) + 1;
  }
  return { total: casts.length, byParent, byFile, byForm };
}

/** @param {Cast[]} casts */
export function formatReport(casts) {
  const { total, byParent, byFile, byForm } = summarize(casts);
  const parents = Object.entries(byParent).sort((left, right) => right[1] - left[1]);
  const files = Object.entries(byFile).sort((left, right) => right[1] - left[1]);
  const forms = Object.entries(byForm).sort((left, right) => right[1] - left[1]);
  const lines = [`${total} type-escape cast(s) under test/`, "", "by form:"];
  for (const [form, count] of forms) lines.push(`  ${String(count).padStart(4)}  ${form}`);
  lines.push("", "by parent node:");
  for (const [parent, count] of parents) lines.push(`  ${String(count).padStart(4)}  ${parent}`);
  lines.push("", "by file:");
  for (const [file, count] of files) lines.push(`  ${String(count).padStart(4)}  ${file}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Every TypeScript source under `directory`, with paths relative to `root`.
 * @param {string} directory
 * @param {string} [root]
 * @returns {Source[]}
 */
export function readSources(directory, root = defaultRoot) {
  const sources = [];
  for (const entry of readdirSync(directory)) {
    const target = path.join(directory, entry);
    if (statSync(target).isDirectory()) {
      sources.push(...readSources(target, root));
    } else if (/\.[cm]?tsx?$/.test(entry)) {
      const relative = path.relative(root, target).split(path.sep).join("/");
      sources.push({ path: relative, text: readFileSync(target, "utf8") });
    }
  }
  return sources;
}

function readBaseline(baselinePath) {
  if (!existsSync(baselinePath)) {
    throw new Error(
      `No cast baseline at ${baselinePath}. Run with --update-baseline once to create it.`,
    );
  }
  return JSON.parse(readFileSync(baselinePath, "utf8"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const baselinePath = args.includes("--baseline")
    ? args[args.indexOf("--baseline") + 1]
    : defaultBaseline;
  const casts = collectCasts(readSources(path.join(defaultRoot, "test")));

  if (args.includes("--update-baseline")) {
    const { total, byForm } = summarize(casts);
    writeFileSync(
      baselinePath,
      `${JSON.stringify({ total, byForm, counts: countByFileForm(casts) }, null, 2)}\n`,
    );
    process.stdout.write(`wrote ${total} cast(s) to ${baselinePath}\n`);
  } else if (args.includes("--check")) {
    const { total } = summarize(casts);
    const violations = compareToBaseline(casts, readBaseline(baselinePath));
    if (violations.length > 0) {
      process.stderr.write(
        `type-escape casts grew: ${violations.length} file/form pair(s) over baseline\n`,
      );
      for (const { key, allowed, count } of violations) {
        process.stderr.write(`  ${key}: ${allowed} -> ${count}\n`);
        for (const cast of casts.filter((c) => `${c.file}:${c.form}` === key)) {
          process.stderr.write(`    ${cast.file}:${cast.line} (${cast.parent})\n`);
        }
      }
      process.exit(1);
    }
    process.stdout.write(`${total} type-escape cast(s), none added\n`);
  } else {
    process.stdout.write(formatReport(casts));
  }
}
