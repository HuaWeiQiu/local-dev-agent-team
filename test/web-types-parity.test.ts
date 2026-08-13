import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * web/src/types.ts hand-mirrors backend contracts. This test parses both sides
 * with the TypeScript compiler API (immune to comments/formatting noise) and
 * fails on drift: enum/union members and request field names must match their
 * backend source of truth.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseSource(relativePath: string): ts.SourceFile {
  const filePath = path.join(repoRoot, relativePath);
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

const backendStateTypes = parseSource("src/state/types.ts");
const backendServerContracts = parseSource("src/server/contracts.ts");
const backendDomainContracts = parseSource("src/domain/contracts.ts");
const backendConfigSchema = parseSource("src/config/schema.ts");
const webTypes = parseSource("web/src/types.ts");

function stringLiteralsOf(node: ts.TypeNode): string[] {
  if (ts.isUnionTypeNode(node)) {
    return node.types.flatMap(stringLiteralsOf);
  }
  if (ts.isParenthesizedTypeNode(node)) {
    return stringLiteralsOf(node.type);
  }
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
    return [node.literal.text];
  }
  throw new Error(`Unsupported union member '${node.getText()}' in ${node.getSourceFile().fileName}`);
}

function typeAliasUnionLiterals(source: ts.SourceFile, aliasName: string): string[] {
  const alias = source.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === aliasName,
  );
  if (!alias) {
    throw new Error(`Type alias '${aliasName}' not found in ${source.fileName}`);
  }
  return stringLiteralsOf(alias.type);
}

function interfaceDeclaration(source: ts.SourceFile, name: string): ts.InterfaceDeclaration {
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );
  if (!declaration) {
    throw new Error(`Interface '${name}' not found in ${source.fileName}`);
  }
  return declaration;
}

function propertyType(members: ts.NodeArray<ts.TypeElement>, name: string): ts.TypeNode {
  const property = members.find(
    (member): member is ts.PropertySignature =>
      ts.isPropertySignature(member) && member.name.getText() === name,
  );
  if (!property?.type) {
    throw new Error(`Property '${name}' not found`);
  }
  return property.type;
}

/** Union literals of a (possibly nested) interface property, e.g. ["TaskRunState", "review", "verdict"]. */
function nestedUnionLiterals(
  source: ts.SourceFile,
  interfaceName: string,
  propertyPath: string[],
): string[] {
  let type = propertyType(interfaceDeclaration(source, interfaceName).members, propertyPath[0]!);
  for (const segment of propertyPath.slice(1)) {
    if (!ts.isTypeLiteralNode(type)) {
      throw new Error(`Property '${segment}' is not an inline object in ${source.fileName}`);
    }
    type = propertyType(type.members, segment);
  }
  return stringLiteralsOf(type);
}

function interfaceFieldNames(source: ts.SourceFile, interfaceName: string): string[] {
  return interfaceDeclaration(source, interfaceName).members.map((member) => member.name.getText());
}

function variableInitializer(source: ts.SourceFile, name: string): ts.Expression {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText() === name && declaration.initializer) {
        return declaration.initializer;
      }
    }
  }
  throw new Error(`Variable '${name}' not found in ${source.fileName}`);
}

function findZodCall(
  node: ts.Node,
  method: "enum" | "object",
): ts.CallExpression | undefined {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === method &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "z"
  ) {
    return node;
  }
  return ts.forEachChild(node, (child) => findZodCall(child, method));
}

/** Members of the first z.enum([...]) inside a schema's initializer. */
function zodEnumLiterals(source: ts.SourceFile, variableName: string): string[] {
  const call = findZodCall(variableInitializer(source, variableName), "enum");
  const array = call?.arguments[0];
  if (!array || !ts.isArrayLiteralExpression(array)) {
    throw new Error(`z.enum([...]) not found in '${variableName}' (${source.fileName})`);
  }
  return array.elements.map((element) => {
    if (!ts.isStringLiteral(element)) {
      throw new Error(`Non-string z.enum member in '${variableName}' (${source.fileName})`);
    }
    return element.text;
  });
}

/** Field names of the first z.object({...}) inside a schema's initializer. */
function zodObjectFieldNames(source: ts.SourceFile, variableName: string): string[] {
  const call = findZodCall(variableInitializer(source, variableName), "object");
  const literal = call?.arguments[0];
  if (!literal || !ts.isObjectLiteralExpression(literal)) {
    throw new Error(`z.object({...}) not found in '${variableName}' (${source.fileName})`);
  }
  return literal.properties.map((property) => property.name!.getText());
}

function sorted(values: string[]): string[] {
  return [...values].sort();
}

describe("web/src/types.ts mirrors the backend contracts", () => {
  it("RunStatus union matches src/state/types.ts", () => {
    expect(sorted(typeAliasUnionLiterals(webTypes, "RunStatus"))).toEqual(
      sorted(typeAliasUnionLiterals(backendStateTypes, "RunStatus")),
    );
  });

  it("TaskStatus union matches src/state/types.ts", () => {
    expect(sorted(typeAliasUnionLiterals(webTypes, "TaskStatus"))).toEqual(
      sorted(typeAliasUnionLiterals(backendStateTypes, "TaskStatus")),
    );
  });

  it("CliId matches roleBindingSchema's cli enum (src/server/contracts.ts)", () => {
    expect(sorted(typeAliasUnionLiterals(webTypes, "CliId"))).toEqual(
      sorted(zodEnumLiterals(backendServerContracts, "roleBindingSchema")),
    );
  });

  it("Finding.severity matches findingSchema's severity enum (src/domain/contracts.ts)", () => {
    expect(sorted(nestedUnionLiterals(webTypes, "Finding", ["severity"]))).toEqual(
      sorted(zodEnumLiterals(backendDomainContracts, "findingSchema")),
    );
  });

  it("review/test verdict unions match the backend verdict enums", () => {
    const reviewEnum = sorted(zodEnumLiterals(backendDomainContracts, "reviewVerdictSchema"));
    const testEnum = sorted(zodEnumLiterals(backendDomainContracts, "testVerdictSchema"));
    expect(sorted(nestedUnionLiterals(webTypes, "TaskRunState", ["review", "verdict"]))).toEqual(reviewEnum);
    expect(sorted(nestedUnionLiterals(webTypes, "TaskRunState", ["test", "verdict"]))).toEqual(testEnum);
  });

  it("RunState.finalDecision.decision matches finalDecisionSchema's decision enum", () => {
    expect(sorted(nestedUnionLiterals(webTypes, "RunState", ["finalDecision", "decision"]))).toEqual(
      sorted(zodEnumLiterals(backendDomainContracts, "finalDecisionSchema")),
    );
  });

  it("StrategyTopologyMode matches strategyTopologyModeSchema (src/config/schema.ts)", () => {
    expect(sorted(typeAliasUnionLiterals(webTypes, "StrategyTopologyMode"))).toEqual(
      sorted(zodEnumLiterals(backendConfigSchema, "strategyTopologyModeSchema")),
    );
  });

  it("ApprovalRequest.gate matches approvalGateSchema (src/config/schema.ts)", () => {
    expect(sorted(nestedUnionLiterals(webTypes, "ApprovalRequest", ["gate"]))).toEqual(
      sorted(zodEnumLiterals(backendConfigSchema, "approvalGateSchema")),
    );
  });

  it("StartRunInput fields stay within startRunRequestSchema and keep the shared core", () => {
    const backendFields = zodObjectFieldNames(backendServerContracts, "startRunRequestSchema");
    const webFields = interfaceFieldNames(webTypes, "StartRunInput");
    for (const field of webFields) {
      expect(backendFields, `web StartRunInput.${field} missing from startRunRequestSchema`).toContain(field);
    }
    for (const field of ["goal", "strategy", "profileOverrides", "roleBindings"]) {
      expect(webFields, `StartRunInput drifted: '${field}' still accepted by the backend`).toContain(field);
      expect(backendFields).toContain(field);
    }
  });

  it("RoleBindingInput fields match roleBindingSchema fields", () => {
    expect(sorted(interfaceFieldNames(webTypes, "RoleBindingInput"))).toEqual(
      sorted(zodObjectFieldNames(backendServerContracts, "roleBindingSchema")),
    );
  });
});
