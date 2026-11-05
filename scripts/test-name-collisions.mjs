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
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultBaseline = path.join(defaultRoot, ".test-name-collisions-baseline.json");

/** Two distinct files that print the same stem. */
function sameStem(left, right) {
  return left.file !== right.file && left.stem === right.stem;
}

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
      if (sameStem(named[i], named[j])) {
        collisions.push({
          left: named[i].file,
          right: named[j].file,
          reason: "same stem, different extension",
        });
      }
    }
  }
  return collisions;
}

/** A stable key for a collision, so a baseline can hold it. */
export function collisionKey(collision) {
  return [collision.left, collision.right].sort().join(" | ");
}

/**
 * Collisions that are not already frozen in the baseline. The four pairs on the
 * baseline are not duplicates — they test different layers of the same feature
 * (`onboarding` over node:fs vs over the DOM, `board` as a pure function vs as a
 * rendered component) — so the baseline records them as known, and the gate only
 * refuses new ones.
 */
export function newCollisions(collisions, baseline) {
  const known = new Set(baseline);
  return collisions.filter((collision) => !known.has(collisionKey(collision)));
}

export function walk(directory, root, out = []) {
  for (const entry of readdirSync(directory)) {
    const target = path.join(directory, entry);
    if (statSync(target).isDirectory()) walk(target, root, out);
    else if (/\.(?:test|spec)\.[cm]?tsx?$/.test(entry)) {
      out.push(path.relative(root, target).split(path.sep).join("/"));
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const collisions = findCollisions(walk(path.join(defaultRoot, "test"), defaultRoot));
  const keys = collisions.map(collisionKey).sort();

  if (args.includes("--update-baseline")) {
    writeFileSync(defaultBaseline, `${JSON.stringify({ known: keys }, null, 2)}\n`);
    process.stdout.write(`wrote ${keys.length} known pair(s) to ${defaultBaseline}\n`);
  } else if (args.includes("--check")) {
    const baseline = existsSync(defaultBaseline)
      ? JSON.parse(readFileSync(defaultBaseline, "utf8")).known
      : [];
    const fresh = newCollisions(collisions, baseline);
    if (fresh.length > 0) {
      process.stderr.write(`${fresh.length} new confusable test file name(s):\n`);
      for (const { left, right, reason } of fresh) {
        process.stderr.write(`  ${left}\n  ${right}   (${reason})\n`);
      }
      process.exit(1);
    }
    process.stdout.write(`${keys.length} confusable name(s), ${fresh.length} new\n`);
  } else {
    for (const { left, right, reason } of collisions) {
      process.stdout.write(`${left}\n${right}   (${reason})\n`);
    }
    process.stdout.write(`${collisions.length} confusable name(s)\n`);
  }
}
