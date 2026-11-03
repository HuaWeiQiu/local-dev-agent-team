import { createHash } from "node:crypto";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPortableRuntime,
  cleanupApplicationStagingDirectories,
  hasChecksum,
} from "../scripts/prepare-desktop-runtime.mjs";
import { cleanupRoots, makeRoot } from "./support/desktop-runtime-fixtures.js";

afterEach(cleanupRoots);

describe("archive checksum", () => {
  it("accepts a file whose digest matches", async () => {
    const root = await makeRoot();
    const file = path.join(root, "archive.tar.gz");
    await writeFile(file, "payload");
    const digest = createHash("sha256").update("payload").digest("hex");
    await expect(hasChecksum(file, digest)).resolves.toBe(true);
  });

  it("rejects a file whose digest differs", async () => {
    const root = await makeRoot();
    const file = path.join(root, "archive.tar.gz");
    await writeFile(file, "payload");
    await expect(hasChecksum(file, "0".repeat(64))).resolves.toBe(false);
  });

  it("treats a missing file as not cached rather than as a failure", async () => {
    const root = await makeRoot();
    await expect(hasChecksum(path.join(root, "absent.tar.gz"), "0".repeat(64))).resolves.toBe(false);
  });

  it("rethrows a read failure that is not about a missing file", async () => {
    // A directory is the cheapest way to make readFile fail without a permission dance, and
    // it stands for the real case: an unreadable archive must not be mistaken for "re-download".
    const root = await makeRoot();
    await mkdir(path.join(root, "archive.tar.gz"));
    await expect(hasChecksum(path.join(root, "archive.tar.gz"), "0".repeat(64))).rejects.toThrow();
  });
});

describe("portability assertion", () => {
  it("accepts a tree of plain files and nested directories", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, "a", "b"), { recursive: true });
    await writeFile(path.join(root, "a", "b", "index.js"), "module.exports = 1;\n");
    await expect(assertPortableRuntime(root)).resolves.toBeUndefined();
  });

  it("rejects a symbolic link anywhere in the tree", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, "a", "b"), { recursive: true });
    await symlink("/usr/lib/libz.dylib", path.join(root, "a", "b", "libz.dylib"));
    await expect(assertPortableRuntime(root)).rejects.toThrow(
      /non-portable symbolic link: .*libz\.dylib$/,
    );
  });

  it("rejects a target-specific native addon", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, "node_modules", "addon"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "addon", "binding.node"), "binary");
    await expect(assertPortableRuntime(root)).rejects.toThrow(
      /target-specific native addon: .*binding\.node$/,
    );
  });
});

describe("staging leftovers", () => {
  it("removes interrupted staging directories and leaves everything else", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, ".app-staging-abc"), { recursive: true });
    await mkdir(path.join(root, ".app-staging-def"), { recursive: true });
    await mkdir(path.join(root, "app"), { recursive: true });
    await writeFile(path.join(root, "NODE-LICENSE"), "license");
    await cleanupApplicationStagingDirectories(root);
    expect((await readdir(root)).sort()).toEqual(["NODE-LICENSE", "app"]);
  });
});
