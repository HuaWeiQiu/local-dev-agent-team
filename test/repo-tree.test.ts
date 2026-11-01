import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { attachTreeNodes } from "../src/domain/architecture-design.js";
import {
  buildRepoTree,
  collectTreeEntries,
  coversElementPaths,
  deepestDirectory,
  selectExperiences,
  tokenScore,
  traceRepo,
  type ExperienceCiteSource,
} from "../src/domain/repo-tree.js";
import { scanRepoPaths } from "../src/workflow/repo-scan.js";

const paths = ["src/orders/export.ts", "src/orders/schema.ts", "web/src/app.tsx"];

function entry(id: string, updatedAt: string, extra: Partial<ExperienceCiteSource> = {}): ExperienceCiteSource {
  return {
    id,
    summary: id,
    conditions: [],
    tags: [],
    updatedAt,
    ...extra,
  };
}

describe("repository tree", () => {
  it("builds directory ancestors and keeps ids stable", () => {
    const tree = buildRepoTree(paths);
    expect(tree.nodes.map((node) => [node.id, node.parentId, node.kind])).toEqual([
      ["root", null, "directory"],
      ["src", "root", "directory"],
      ["web", "root", "directory"],
      ["src-orders", "src", "directory"],
      ["web-src", "web", "directory"],
      ["src-orders-export-ts", "src-orders", "file"],
      ["src-orders-schema-ts", "src-orders", "file"],
      ["web-src-app-tsx", "web-src", "file"],
    ]);
    expect(buildRepoTree(["a.b", "a-b"]).nodes.map((node) => node.id)).toEqual(["root", "a-b", "a-b-2"]);
  });

  it("counts each path once and orders directories parent-first", () => {
    expect(collectTreeEntries([])).toEqual({ directories: [], files: [] });
    expect(
      collectTreeEntries([
        "src/orders/export.ts",
        "src\\orders\\export.ts",
        "web/src/app.tsx",
        "notes.tar.gz",
        "b/z.ts",
        "a.ts",
      ]),
    ).toEqual({
      directories: ["b", "src", "web", "src/orders", "web/src"],
      files: ["a.ts", "b/z.ts", "notes.tar.gz", "src/orders/export.ts", "web/src/app.tsx"],
    });
    const long = `${"deep/".repeat(40)}leaf.weirdext`;
    const entries = collectTreeEntries([long]);
    expect(entries.files).toEqual([long]);
    expect(entries.directories).toHaveLength(40);
  });

  it("builds from duplicates, deep nesting, and an empty list", () => {
    expect(buildRepoTree([])).toEqual({
      nodes: [{ id: "root", parentId: null, path: "", name: "root", kind: "directory" }],
    });
    expect(buildRepoTree(["src/a.ts", "src/a.ts"]).nodes.map((node) => node.id)).toEqual([
      "root",
      "src",
      "src-a-ts",
    ]);
    expect(buildRepoTree(["a/b/c/d.ts"]).nodes.map((node) => [node.id, node.parentId, node.kind])).toEqual([
      ["root", null, "directory"],
      ["a", "root", "directory"],
      ["a-b", "a", "directory"],
      ["a-b-c", "a-b", "directory"],
      ["a-b-c-d-ts", "a-b-c", "file"],
    ]);
  });

  it("scores a whole path segment above a partial one", () => {
    expect(tokenScore(["src", "orders", "export.ts"], "orders")).toBe(3);
    expect(tokenScore(["src", "orders", "export.ts"], "export")).toBe(3);
    expect(tokenScore(["src", "orders"], "order")).toBe(1);
    expect(tokenScore(["ord"], "orders")).toBe(1);
    expect(tokenScore(["ab"], "abc")).toBe(0);
    expect(tokenScore(["src"], "worker")).toBe(0);
  });

  it("keeps a directory that does not cover every sibling lookalike out", () => {
    const nodes = buildRepoTree(["src/orders/a.ts", "src/orders2/b.ts"]).nodes;
    const orders = nodes.find((node) => node.path === "src/orders");
    const file = nodes.find((node) => node.kind === "file");
    expect(orders && coversElementPaths(orders, ["src/orders", "src/orders/a.ts"])).toBe(true);
    expect(orders && coversElementPaths(orders, ["src/orders2/b.ts"])).toBe(false);
    expect(orders && coversElementPaths(orders, [])).toBe(true);
    expect(file && coversElementPaths(file, ["src/orders/a.ts"])).toBe(false);
  });

  it("matches a quoted path even when no token is long enough to score", () => {
    const tree = buildRepoTree(["a/b.ts", "c/d.ts"]);
    expect(traceRepo(tree, "a/b.ts")).toMatchObject({
      matched: true,
      nodes: [{ path: "" }, { path: "a" }, { path: "a/b.ts" }],
    });
    expect(traceRepo(tree, "cd").nodes.map((node) => node.path)).toEqual(["", "a", "c"]);
  });

  it("walks matching leaves with their ancestors", () => {
    const trace = traceRepo(buildRepoTree(paths), "export the orders csv");
    expect(trace.matched).toBe(true);
    expect(trace.nodes.map((node) => node.path)).toEqual([
      "",
      "src",
      "src/orders",
      "src/orders/export.ts",
      "src/orders/schema.ts",
    ]);
  });

  it("returns the top directories when the goal names no path", () => {
    const trace = traceRepo(buildRepoTree(paths), "给购物车增加优惠券");
    expect(trace.matched).toBe(false);
    expect(trace.nodes.map((node) => node.path)).toEqual(["", "src", "web", "src/orders", "web/src"]);
  });

  it("ranks an experience that cites a hit path ahead of a token-only note", () => {
    const trace = traceRepo(buildRepoTree(paths), "export orders");
    const ranked = selectExperiences(
      [
        entry("token", "2026-01-02T00:00:00.000Z", { summary: "orders retry", tags: ["orders"] }),
        entry("path", "2026-01-01T00:00:00.000Z", { conditions: ["when editing src/orders/export.ts"] }),
        entry("unrelated", "2026-01-03T00:00:00.000Z", { summary: "retry the worker", tags: ["worker"] }),
      ],
      trace,
      5,
    );
    expect(ranked.map((item) => item.entry.id)).toEqual(["path", "token"]);
    expect(ranked[0]?.citations.some((citation) => citation.path === "src/orders/export.ts")).toBe(true);
    expect(selectExperiences([entry("loose", "2026-01-02T00:00:00.000Z")], { matched: false, nodes: [] }, 5)).toEqual([]);
  });

  it("binds an element to the deepest covering directory and drops a hallucinated id", () => {
    const tree = buildRepoTree(paths);
    expect(deepestDirectory(tree, ["src/orders/export.ts", "src/orders/schema.ts"])).toBe("src-orders");
    const element = {
      id: "orders",
      name: "订单",
      kind: "module" as const,
      responsibility: "导出",
      paths: ["src/orders"],
      nodeId: "invented",
    };
    const linked = attachTreeNodes(
      {
        summary: "导出",
        tasks: [],
        design: {
          summary: "导出",
          source: "architect",
          elements: [element],
          relations: [],
          sequence: [],
        },
      },
      tree,
    );
    expect(linked.design?.elements[0]).toMatchObject({ id: "orders", nodeId: "src-orders" });
    const cleared = attachTreeNodes(linked, undefined);
    expect(cleared.design?.elements[0]).not.toHaveProperty("nodeId");
  });

  it("skips dependency directories, dot directories, and symlinks", () => {
    const root = mkdtempSync(path.join(tmpdir(), "repo-scan-"));
    try {
      mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
      writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "");
      mkdirSync(path.join(root, ".git"), { recursive: true });
      writeFileSync(path.join(root, ".git", "config"), "");
      mkdirSync(path.join(root, "src", "orders"), { recursive: true });
      writeFileSync(path.join(root, "src", "orders", "export.ts"), "");
      symlinkSync(path.join(root, "src"), path.join(root, "linked"));
      expect(scanRepoPaths(root)).toEqual(["src/orders/export.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
