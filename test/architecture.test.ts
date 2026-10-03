import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Locks the module layering of src/. Edges are runtime (value) imports between
 * top-level packages; `import type` is erased at compile time and ignored.
 * Dynamic `import()` is ignored on purpose: it is how config lazily reaches
 * the adapter registry without a static edge.
 */

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const ROOT = "(root)";

function listSources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return listSources(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

function packageOf(file: string): string {
  const relative = path.relative(srcDir, file).split(path.sep);
  return relative.length > 1 ? relative[0]! : ROOT;
}

function isValueImport(statement: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (!clause) return true;
    if (clause.isTypeOnly) return false;
    if (clause.name) return true;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) return true;
    if (bindings && ts.isNamedImports(bindings)) {
      return bindings.elements.some((element) => !element.isTypeOnly);
    }
    return true;
  }
  if (statement.isTypeOnly) return false;
  const clause = statement.exportClause;
  if (clause && ts.isNamedExports(clause)) {
    return clause.elements.some((element) => !element.isTypeOnly);
  }
  return true;
}

function buildGraph(): Map<string, Map<string, string>> {
  const graph = new Map<string, Map<string, string>>();
  for (const file of listSources(srcDir)) {
    const from = packageOf(file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) continue;
      if (!isValueImport(statement)) continue;
      const target = packageOf(path.resolve(path.dirname(file), specifier.text));
      if (target === from) continue;
      const edges = graph.get(from) ?? new Map<string, string>();
      if (!edges.has(target)) edges.set(target, path.relative(srcDir, file));
      graph.set(from, edges);
    }
  }
  return graph;
}

const graph = buildGraph();
const importsOf = (pkg: string): string[] => [...(graph.get(pkg)?.keys() ?? [])].sort();

describe("src layering", () => {
  it("sees the real import graph", () => {
    expect(importsOf("server")).toEqual(expect.arrayContaining(["workflow", "evolution", "state"]));
    expect(importsOf("workflow")).toEqual(expect.arrayContaining(["agents", "flow", "git"]));
  });

  it("sees the real import graph", () => {
    expect(importsOf("server")).toContain("workflow");
    expect(importsOf("workflow")).toContain("flow");
  });

  it("has no runtime import cycles between packages", () => {
    const visiting: string[] = [];
    const done = new Set<string>();
    const cycles: string[] = [];
    const visit = (pkg: string): void => {
      if (done.has(pkg)) return;
      const at = visiting.indexOf(pkg);
      if (at >= 0) {
        cycles.push([...visiting.slice(at), pkg].join(" -> "));
        return;
      }
      visiting.push(pkg);
      for (const next of importsOf(pkg)) visit(next);
      visiting.pop();
      done.add(pkg);
    };
    for (const pkg of graph.keys()) visit(pkg);
    expect(cycles).toEqual([]);
  });

  it("keeps the foundation packages free of higher-level dependencies", () => {
    const foundation = ["domain", "process", "security", "events", "state", "git", "quality", "config"];
    const above = [
      "agents", "sessions", "workflow", "server", "workspace", "evolution", "desktop",
      "visibility", "onboarding", "interventions", "github", "adapters", "flow",
    ];
    const offenders = foundation.flatMap((pkg) =>
      importsOf(pkg)
        .filter((target) => above.includes(target))
        .map((target) => `${pkg} -> ${target} (${graph.get(pkg)?.get(target)})`),
    );
    expect(offenders).toEqual([]);
  });

  it("lets only the control surface reach the server, evolution and workspace packages", () => {
    const surface = new Set(["server", "workspace", ROOT]);
    const offenders: string[] = [];
    for (const [pkg, edges] of graph) {
      if (surface.has(pkg)) continue;
      for (const guarded of ["server", "workspace"]) {
        if (edges.has(guarded)) offenders.push(`${pkg} -> ${guarded} (${edges.get(guarded)})`);
      }
      if (pkg !== "evolution" && edges.has("evolution")) {
        offenders.push(`${pkg} -> evolution (${edges.get("evolution")})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the run engine independent of the desktop shell and the evolution subsystem", () => {
    const engine = ["workflow", "flow", "sessions", "agents", "interventions", "reliability", "visibility"];
    const offenders = engine.flatMap((pkg) =>
      importsOf(pkg)
        .filter((target) => ["desktop", "evolution", "server", "workspace", "onboarding"].includes(target))
        .map((target) => `${pkg} -> ${target} (${graph.get(pkg)?.get(target)})`),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps adapters and sessions independent of workflow policy", () => {
    const offenders = ["adapters", "sessions", "providers", "process"].flatMap((pkg) =>
      importsOf(pkg)
        .filter((target) => ["workflow", "flow", "server", "state", "evolution"].includes(target))
        .map((target) => `${pkg} -> ${target} (${graph.get(pkg)?.get(target)})`),
    );
    expect(offenders).toEqual([]);
  });
});
