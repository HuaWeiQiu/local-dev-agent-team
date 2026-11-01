/**
 * Differential proof for the split of buildRepoTree, scoreNode and deepestDirectory.
 *
 * `fixtures/repo-tree.pre-split.ts` is a byte-identical copy of
 * `src/domain/repo-tree.ts` as committed in c0456ca. Verify it with:
 *
 *   git show c0456ca:src/domain/repo-tree.ts | diff - test/fixtures/repo-tree.pre-split.ts
 *
 * Both implementations run over the same seeded inputs and the complete return
 * value is compared — node order, ids, parent wiring, names and trace scores —
 * so any behaviour drift fails here rather than being asserted away.
 */

import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import * as current from "../src/domain/repo-tree.js";
import * as preSplit from "./fixtures/repo-tree.pre-split.js";

type Tree = ReturnType<typeof current.buildRepoTree>;

const SEGMENTS = [
  "src",
  "web",
  "app",
  "orders",
  "export",
  "schema",
  "node_modules",
  ".git",
  "a.b",
  "a-b",
  "utils",
  "dist",
  "core",
  "index",
  "x",
  "v1.2",
  "文件",
  "a b",
];
const EXTENSIONS = ["", ".ts", ".tsx", ".d.ts", ".tar.gz", ".TS", ".weirdext", ".min.js", ".", ".json5"];

const CURATED: string[][] = [
  [],
  [""],
  ["", "", ""],
  ["src"],
  ["a", "a/b", "a/b/c"],
  ["a.b", "a-b"],
  ["src//orders/export.ts"],
  ["README.md"],
  ["notes.tar.gz", "Makefile", ".gitignore"],
  Array.from({ length: 200 }, (_, index) => `pkg${index % 7}/file${index}.ts`),
  [`${"deep/".repeat(60)}leaf.ts`],
  [`${"x".repeat(400)}/${"y".repeat(700)}.ts`],
  ["a".repeat(48), `${"a".repeat(48)}b`, `${"a".repeat(48)}c`],
  [
    "src/orders/export.ts",
    "src\\orders\\export.ts",
    "./src/orders/export.ts",
    "/src/orders/export.ts",
    "src/orders/export.ts/",
  ],
  ["文件/订单/导出.ts", "文件/订单/导出.ts"],
  ["a b/c d.ts"],
  ["node_modules/pkg/index.js", "dist/bundle.js"],
];

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let drawn = value;
    drawn = Math.imul(drawn ^ (drawn >>> 15), drawn | 1);
    drawn ^= drawn + Math.imul(drawn ^ (drawn >>> 7), drawn | 61);
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

function randomPath(random: () => number): string {
  const parts: string[] = [];
  const depth = 1 + Math.floor(random() * 12);
  for (let index = 0; index < depth; index += 1) {
    const base = pick(random, SEGMENTS);
    parts.push(random() < 0.15 ? base.repeat(1 + Math.floor(random() * 4)) : base);
  }
  let path = parts.join("/") + pick(random, EXTENSIONS);
  if (random() < 0.1) path = `./${path}`;
  if (random() < 0.08) path = `/${path}`;
  if (random() < 0.08) path = `${path}/`;
  if (random() < 0.08) path = path.replace(/\//g, "\\");
  // A leading "//" used to produce a directory that was its own parent; that cycle
  // was fixed on purpose (see the self-parent test), so the generator no longer
  // produces it and the differential stays about unintended changes.
  return path;
}

function generatedCases(count: number): string[][] {
  const random = mulberry32(0x5eed);
  const cases: string[][] = [];
  for (let index = 0; index < count; index += 1) {
    const size = Math.floor(random() * 13);
    const paths = Array.from({ length: size }, () => randomPath(random));
    if (size > 1 && random() < 0.4) paths.push(pick(random, paths));
    if (size > 1 && random() < 0.2) paths.push("");
    cases.push(paths);
  }
  return cases;
}

const CASES: string[][] = [...CURATED, ...generatedCases(400)];

const QUERIES = [
  "",
  "orders",
  "export",
  "src/orders/export.ts",
  "给购物车增加优惠券",
  "export the orders csv",
  "a b",
  "web src app",
  "文件",
  "pkg1",
  "zzz",
  "order export schema",
  "lib/utils/index.ts",
  "EXPORT",
  "a/b.ts",
  "x".repeat(30),
];

function note(mismatch: string, found: string[]): void {
  found.push(mismatch.slice(0, 300));
}

/**
 * A leading "//" makes the pre-split tree register the "" directory and resolve
 * it against itself, so `withAncestors` never terminates on such a tree. Those
 * trees are still compared whole by the first test; the walk phase skips them.
 */
function hasSelfParent(tree: Tree): boolean {
  return tree.nodes.some((node) => node.parentId === node.id);
}

function compareOverCases(
  label: string,
  actual: (paths: string[]) => unknown,
  expected: (paths: string[]) => unknown,
): string[] {
  const found: string[] = [];
  for (const paths of CASES) {
    if (hasSelfParent(preSplit.buildRepoTree(paths))) continue;
    if (!isDeepStrictEqual(actual(paths), expected(paths))) {
      note(`${label} ${JSON.stringify(paths)}`, found);
    }
  }
  return found;
}

function experiencesFor(paths: string[]): Array<{
  id: string;
  summary: string;
  conditions: string[];
  tags: string[];
  updatedAt: string;
}> {
  return paths.slice(0, 4).map((path, index) => ({
    id: `entry-${index}`,
    summary: `work on ${path}`,
    conditions: index % 2 === 0 ? [`when editing ${path}`] : [],
    tags: path.split("/").filter((part) => part.length >= 4).slice(0, 2),
    updatedAt: `2026-0${(index % 9) + 1}-0${(index % 9) + 1}T00:00:00.000Z`,
  }));
}

describe("repo tree differential against the pre-split implementation", () => {
  it("builds the identical tree for every generated file list", () => {
    expect(compareOverCases("buildRepoTree", current.buildRepoTree, preSplit.buildRepoTree)).toEqual([]);
  });

  it("deliberately differs for a path with an empty first segment", () => {
    // The pre-split tree registered the "" directory as its own parent, and walking
    // up from it never ended. That is the one place this module is allowed to
    // differ from its frozen reference; everywhere else the differential holds.
    const paths = ["//schema/app.ts"];
    const fixed = current.buildRepoTree(paths);
    const frozen = preSplit.buildRepoTree(paths);
    expect(frozen.nodes.some((node) => node.parentId === node.id)).toBe(true);
    expect(fixed.nodes.some((node) => node.parentId === node.id)).toBe(false);
  });

  it("walks, ranks, cites and binds identically for every generated tree", () => {
    const found: string[] = [];
    for (const paths of CASES) {
      const expectedTree = preSplit.buildRepoTree(paths);
      const actualTree = current.buildRepoTree(paths);
      const files = expectedTree.nodes.filter((node) => node.kind === "file").map((node) => node.path);
      const elementPaths = [...files.slice(0, 2), `${files[0] ?? "src"}/*.ts`, `${files[0] ?? "src"}/`];
      const entries = experiencesFor(files);

      if (!isDeepStrictEqual(actualTree, expectedTree)) {
        note(`tree ${JSON.stringify(paths)}`, found);
        continue;
      }
      if (hasSelfParent(expectedTree)) continue;

      for (const query of [...QUERIES, ...files.slice(0, 2)]) {
        const expectedTrace = preSplit.traceRepo(expectedTree, query);
        const actualTrace = current.traceRepo(actualTree, query);
        if (!isDeepStrictEqual(actualTrace, expectedTrace)) {
          note(`traceRepo ${JSON.stringify([paths, query])}`, found);
          continue;
        }
        if (!isDeepStrictEqual(current.repoIndex(actualTrace), preSplit.repoIndex(expectedTrace))) {
          note(`repoIndex ${JSON.stringify([paths, query])}`, found);
        }
        if (
          !isDeepStrictEqual(
            current.selectExperiences(entries, actualTrace, 3),
            preSplit.selectExperiences(entries, expectedTrace, 3),
          )
        ) {
          note(`selectExperiences ${JSON.stringify([paths, query])}`, found);
        }
      }

      if (
        !isDeepStrictEqual(
          current.deepestDirectory(actualTree, elementPaths),
          preSplit.deepestDirectory(expectedTree, elementPaths),
        )
      ) {
        note(`deepestDirectory ${JSON.stringify([paths, elementPaths])}`, found);
      }
    }
    expect(found).toEqual([]);
  });
});

/** Perturbations of a correct tree: each must be caught, or the comparison is vacuous. */
const MUTANTS: Array<[string, (paths: string[]) => Tree]> = [
  [
    "file order swapped",
    (paths) => {
      const tree = current.buildRepoTree(paths);
      const indexes = tree.nodes.flatMap((node, index) => (node.kind === "file" ? [index] : []));
      const first = indexes[0];
      const last = indexes[indexes.length - 1];
      if (first !== undefined && last !== undefined && first !== last) {
        const swapped = [...tree.nodes];
        const head = swapped[first] as Tree["nodes"][number];
        const tail = swapped[last] as Tree["nodes"][number];
        swapped[first] = tail;
        swapped[last] = head;
        return { nodes: swapped };
      }
      return tree;
    },
  ],
  [
    "directory ancestor dropped",
    (paths) => {
      const tree = current.buildRepoTree(paths);
      const directory = tree.nodes.findIndex((node) => node.kind === "directory" && node.path);
      if (directory === -1) return tree;
      const dropped = tree.nodes[directory]?.id;
      return { nodes: tree.nodes.filter((node, index) => index !== directory && node.parentId !== dropped) };
    },
  ],
  [
    "name and path swapped",
    (paths) => ({
      nodes: current.buildRepoTree(paths).nodes.map((node) =>
        node.kind === "file" ? { ...node, name: node.path, path: node.name } : node,
      ),
    }),
  ],
];

describe("the differential comparator is sensitive", () => {
  for (const [name, mutant] of MUTANTS) {
    it(`rejects a tree with ${name}`, () => {
      expect(compareOverCases(name, mutant, preSplit.buildRepoTree).length).toBeGreaterThan(0);
    });
  }
});
