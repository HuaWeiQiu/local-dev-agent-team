import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepoPaths } from "../src/workflow/repo-scan.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-repo-scan-"));
  await mkdir(path.join(root, "src", "nested"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "readme\n", "utf8");
  await writeFile(path.join(root, "src", "index.ts"), "export {};\n", "utf8");
  await writeFile(path.join(root, "src", "nested", "deep.ts"), "export {};\n", "utf8");
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "\n", "utf8");
  await writeFile(path.join(root, ".hidden"), "\n", "utf8");
  return root;
}

describe("scanRepoPaths", () => {
  it("lists files with forward slashes and skips dependencies, dot entries and build output", async () => {
    const root = await fixture();

    const found = scanRepoPaths(root);

    expect(found).toContain("README.md");
    expect(found).toContain("src/index.ts");
    expect(found).toContain("src/nested/deep.ts");
    expect(found.some((entry) => entry.includes("node_modules"))).toBe(false);
    expect(found.some((entry) => entry.includes(".hidden"))).toBe(false);
  });

  it("respects the depth limit", async () => {
    const root = await fixture();

    const found = scanRepoPaths(root, { maxDepth: 1 });

    expect(found).toContain("src/index.ts");
    expect(found).not.toContain("src/nested/deep.ts");
  });

  it("stops at the file budget", async () => {
    const root = await fixture();

    const found = scanRepoPaths(root, { maxFiles: 21 });

    expect(found.length).toBeLessThanOrEqual(21);
  });

  it("does not follow a symlinked directory", async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), "agent-team-outside-"));
    await writeFile(path.join(outside, "secret.ts"), "\n", "utf8");
    await symlink(outside, path.join(root, "linked"), "dir");

    const found = scanRepoPaths(root);

    expect(found.some((entry) => entry.includes("secret.ts"))).toBe(false);
  });

  it("returns nothing for a root it cannot read", () => {
    expect(scanRepoPaths(path.join(tmpdir(), "does-not-exist-agent-team"))).toEqual([]);
  });
});
