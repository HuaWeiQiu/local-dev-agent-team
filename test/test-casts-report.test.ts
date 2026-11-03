import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectCasts, formatReport, readSources, summarize } from "../scripts/test-casts-report.mjs";

const castsIn = (text: string, path = "test/sample.test.ts") => collectCasts([{ path, text }]);

describe("cast reporting", () => {
  it("finds a cast and reports the parent node that positions it", () => {
    const casts = castsIn("const a = 1 as never;\nconst b = { k: 2 } as never;\n");
    expect(casts).toEqual([
      { file: "test/sample.test.ts", line: 1, parent: "VariableDeclaration", form: "never" },
      { file: "test/sample.test.ts", line: 2, parent: "VariableDeclaration", form: "never" },
    ]);
  });

  it("does not count the words 'was never' as a cast", () => {
    // The text search that produced the first audit counted this line, because
    // "was never" contains "as never". The compiler sees a string literal.
    const casts = castsIn('const note = "a candidate that was never promoted";\n');
    expect(casts).toEqual([]);
  });

  it("counts two casts on one line, where a line-based search counts one", () => {
    const casts = castsIn("const pair = [1 as never, 2 as never];\n");
    expect(casts).toHaveLength(2);
    expect(casts.every((cast) => cast.line === 1)).toBe(true);
  });

  it("reports the line the expression starts on, not the line of the keyword", () => {
    const casts = castsIn("const wrapped = {\n  a: 1,\n} as never;\n");
    expect(casts[0]).toMatchObject({ line: 1, parent: "VariableDeclaration" });
  });

  it("parses a .tsx source as TSX", () => {
    const casts = castsIn("const node = <div {...({} as never)} />;\n", "test/sample.test.tsx");
    expect(casts).toHaveLength(1);
  });

  it("walks a directory tree and keeps only TypeScript sources", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "casts-report-"));
    await mkdir(path.join(root, "test", "nested"), { recursive: true });
    await writeFile(path.join(root, "test", "a.ts"), "const a = 1 as never;\n");
    await writeFile(path.join(root, "test", "b.tsx"), "const b = null;\n");
    await writeFile(path.join(root, "test", "nested", "c.ts"), "const c = 2;\n");
    await writeFile(path.join(root, "test", "notes.md"), "not a source\n");

    const sources = readSources(path.join(root, "test"), root);
    expect(sources.map((source) => source.path).sort()).toEqual([
      "test/a.ts",
      "test/b.tsx",
      "test/nested/c.ts",
    ]);
    expect(collectCasts(sources)).toHaveLength(1);
  });

  it("counts the double cast as its own form, not as a never", () => {
    // `as unknown as T` needs no `never` and reads like a necessary widening,
    // but it turns off the same check. A report tracking only `as never` would
    // measure how often we chose that spelling.
    const casts = castsIn(
      "const a = 1 as never;\nconst b = {} as unknown as { x: number };\nconst c = 2 as any;\n",
    );
    expect(casts.map((cast) => cast.form)).toEqual(["never", "unknown-as", "any"]);
  });

  it("summarises by form, parent and file, and formats all three", () => {
    const casts = castsIn("const a = 1 as never;\nconst b = [{ c: 2 } as never];\nconst d = {} as unknown as X;\n");
    expect(summarize(casts)).toMatchObject({
      total: 3,
      byForm: { never: 2, "unknown-as": 1 },
      byParent: { ArrayLiteralExpression: 1, VariableDeclaration: 2 },
      byFile: { "test/sample.test.ts": 3 },
    });
    const report = formatReport(casts);
    expect(report).toContain("3 type-escape cast(s) under test/");
    expect(report).toContain("by form:");
    expect(report).toContain("by parent node:");
    expect(report).toContain("by file:");
  });
});
