import { describe, expect, it } from "vitest";
import { buildRepoTree, traceRepo } from "../src/domain/repo-tree.js";

describe("a path that leads with a slash", () => {
  it("never makes a directory its own parent", () => {
    const tree = buildRepoTree(["//schema/v1/app.ts"]);
    expect(tree.nodes.filter((node) => node.parentId === node.id)).toEqual([]);
  });

  it("still terminates when walking the tree", () => {
    const tree = buildRepoTree(["//schema/v1/app.ts", "src/index.ts"]);
    const trace = traceRepo(tree, "schema");
    expect(trace.matched).toBe(true);
    expect(trace.nodes.length).toBeGreaterThan(0);
  });

  it("leaves ordinary paths exactly as they were", () => {
    const tree = buildRepoTree(["src/domain/repo-tree.ts"]);
    const file = tree.nodes.find((node) => node.path === "src/domain/repo-tree.ts");
    const directory = tree.nodes.find((node) => node.path === "src/domain");
    expect(file?.parentId).toBe(directory?.id);
    expect(tree.nodes.every((node) => node.parentId !== node.id)).toBe(true);
  });
});
