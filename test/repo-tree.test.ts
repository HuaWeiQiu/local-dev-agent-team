import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { attachTreeNodes } from "../src/domain/architecture-design.js";
import {
  buildRepoTree,
  deepestDirectory,
  selectExperiences,
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
