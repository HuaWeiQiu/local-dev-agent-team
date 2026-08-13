import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The config package must stay decoupled from the packages it used to
 * value-import (adapters, evaluation): cross-package validation is injected
 * via LoadConfigOptions and loaded lazily at the assembly points. This test
 * fails if a static import edge back into those packages is reintroduced.
 */

const configDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "config",
);

const forbiddenStaticEdges = [/^\.\.\/adapters(\/|$)/, /^\.\.\/evaluation(\/|$)/];

describe("config package decoupling", () => {
  it("src/config has no static import of adapters or evaluation", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(configDir).filter((name) => name.endsWith(".ts"))) {
      const filePath = path.join(configDir, file);
      const source = ts.createSourceFile(
        filePath,
        readFileSync(filePath, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
        // import type 在编译期擦除，不构成运行时耦合，只拦值导入。
        if (statement.importClause?.isTypeOnly) continue;
        if (forbiddenStaticEdges.some((pattern) => pattern.test(specifier))) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
