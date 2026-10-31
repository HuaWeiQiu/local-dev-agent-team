import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "../src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

const files = sourceFiles(SRC).map((file) => ({
  file: path.relative(SRC, file),
  text: readFileSync(file, "utf8"),
}));

describe("repository-wide safety invariants", () => {
  it("never starts a process through a shell", () => {
    const offenders = files
      .filter(({ text }) => /shell\s*:\s*true/.test(text) || /\bexecSync\s*\(/.test(text) || /from\s+["']node:child_process["'][^;]*\b(exec|execSync)\b/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("only the process and liveness modules import child_process", () => {
    const importers = files
      .filter(({ text }) => /from\s+["'](node:)?child_process["']/.test(text))
      .map(({ file }) => file)
      .sort();
    expect(importers).toEqual(["process/alive.ts", "process/live-children.ts", "process/run.ts", "process/stream.ts"].sort());
  });

  it("does not persist credentials in state or configuration code paths", () => {
    const offenders = files
      .filter(({ text }) => /(writeFile|appendFile)[^;]*\b(apiKey|api_key|accessToken|refreshToken)\b/i.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("never force-pushes", () => {
    const offenders = files
      .filter(({ text }) => /\[[^\]]*["']push["'][^\]]*(--force|["']-f["']|\+refs)/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
