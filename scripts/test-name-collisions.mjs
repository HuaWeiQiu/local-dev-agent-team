#!/usr/bin/env node
/**
 * Refuse two test files whose names become confusable once the directory is
 * dropped from the report.
 *
 * `test/web/run-actions.test.tsx` and `test/web-run-actions.test.tsx` are a real
 * pair from this repo. A compiler error prints `run-actions.test.tsx(43,8)`,
 * which is the *suffix* of both — and the two files both have 43 lines. Editing
 * the wrong one costs a round and looks like carelessness afterwards.
 *
 * The rule: two test files collide when their stems match but their extensions
 * differ — `onboarding.test.ts` and `onboarding.test.tsx` print the same stem, so
 * a compiler error naming one is a coin flip.
 *
 * Suffix relationships are deliberately *not* reported: `doctor` inside
 * `adapters-doctor`, `server` inside `evolution-server` and `config` inside
 * `vitest-coverage-config` are ordinary naming, and a first version that flagged
 * them produced 72 hits, nearly all noise. That also means this check would not
 * have caught the `run-actions` / `web-run-actions` pair — the fix for that was
 * the move, and the habit of reading the reported line before editing.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string[]} paths */
export function findCollisions(paths) {
  const named = paths.map((file) => ({
    file,
    base: path.basename(file),
    stem: path.basename(file).replace(/\.(?:test|spec)\.[cm]?tsx?$/, ""),
  }));
  const collisions = [];
  for (let i = 0; i < named.length; i += 1) {
    for (let j = i + 1; j < named.length; j += 1) {
      const [left, right] = [named[i], named[j]];
      if (left.file === right.file) continue;
      if (left.stem === right.stem) {
        collisions.push({ left: left.file, right: right.file, reason: "same stem, different extension" });
      }
    }
  }
  return collisions;
}

function walk(directory, out = []) {
  for (const entry of readdirSync(directory)) {
    const target = path.join(directory, entry);
    if (statSync(target).isDirectory()) walk(target, out);
    else if (/\.(?:test|spec)\.[cm]?tsx?$/.test(entry)) {
      out.push(path.relative(defaultRoot, target).split(path.sep).join("/"));
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const collisions = findCollisions(walk(path.join(defaultRoot, "test")));
  if (collisions.length > 0) {
    process.stderr.write(`${collisions.length} confusable test file name(s):\n`);
    for (const { left, right, reason } of collisions) {
      process.stderr.write(`  ${left}\n  ${right}   (${reason})\n`);
    }
    process.exit(1);
  }
  process.stdout.write("no confusable test file names\n");
}
