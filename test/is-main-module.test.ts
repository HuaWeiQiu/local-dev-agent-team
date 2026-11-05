import { symlinkSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isMainModule } from "../scripts/lib/is-main-module.mjs";

describe("is this module the entry point", () => {
  it("says no when the process has no entry path at all", () => {
    const url = pathToFileURL("/nowhere/gate.mjs").href;
    expect(isMainModule(url, undefined)).toBe(false);
    expect(isMainModule(url, "")).toBe(false);
  });

  it("says no for a different file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "main-module-"));
    const other = path.join(root, "other.mjs");
    await writeFile(other, "");
    expect(isMainModule(pathToFileURL(path.join(root, "gate.mjs")).href, other)).toBe(false);
  });

  it("says yes through a symlink, because a path is not a string", async () => {
    // The macOS shape of the bug: /tmp is a symlink to /private/tmp, so the
    // entry path and `import.meta.url` are two spellings of one file. String
    // equality says no, the block is skipped, and the process exits 0 having
    // checked nothing.
    const root = await mkdtemp(path.join(tmpdir(), "main-module-"));
    const real = path.join(root, "gate.mjs");
    await writeFile(real, "");
    const link = path.join(root, "gate-link.mjs");
    symlinkSync(real, link);

    expect(pathToFileURL(real).href).not.toBe(pathToFileURL(link).href);
    expect(isMainModule(pathToFileURL(real).href, link)).toBe(true);
  });

  it("says no, rather than throwing, for a path that does not exist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "main-module-"));
    const url = pathToFileURL(path.join(root, "gate.mjs")).href;
    expect(isMainModule(url, path.join(root, "absent.mjs"))).toBe(false);
  });
});
