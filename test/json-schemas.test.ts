import { describe, expect, it } from "vitest";
import {
  exploreSummaryJsonSchema,
  finalDecisionJsonSchema,
  goalIntakeJsonSchema,
  reviewVerdictJsonSchema,
  taskPlanJsonSchema,
  testVerdictJsonSchema,
} from "../src/domain/json-schemas.js";
import {
  exploreSummarySchema,
  finalDecisionSchema,
  goalIntakeSchema,
  reviewVerdictSchema,
  taskPlanSchema,
  testVerdictSchema,
} from "../src/domain/contracts.js";

type JsonSchema = Record<string, unknown>;

/**
 * Minimal JSON Schema validator covering exactly the keyword subset that
 * z.toJSONSchema emits for the domain contracts (type/enum/required/properties/
 * additionalProperties/items/minItems/minLength/maxLength/pattern/minimum/
 * maximum/exclusiveMinimum/anyOf). `default` is annotation-only and ignored.
 */
function validateJsonSchema(value: unknown, schema: JsonSchema): boolean {
  if (Array.isArray(schema.anyOf)) {
    return (schema.anyOf as JsonSchema[]).some((sub) => validateJsonSchema(value, sub));
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
    return false;
  }
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") return false;
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return false;
      break;
    case "number":
      if (typeof value !== "number") return false;
      break;
    case "boolean":
      if (typeof value !== "boolean") return false;
      break;
    case "null":
      if (value !== null) return false;
      break;
    case "array":
      if (!Array.isArray(value)) return false;
      break;
    case "object":
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      break;
    default:
      break;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (schema.items && typeof schema.items === "object") {
      for (const item of value) {
        if (!validateJsonSchema(item, schema.items as JsonSchema)) return false;
      }
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in record)) return false;
    }
    const properties = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
    for (const [key, sub] of Object.entries(properties)) {
      if (key in record && !validateJsonSchema(record[key], sub)) return false;
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) return false;
      }
    }
  }
  return true;
}

function collectObjectNodes(node: unknown, found: JsonSchema[] = []): JsonSchema[] {
  if (Array.isArray(node)) {
    for (const item of node) collectObjectNodes(item, found);
    return found;
  }
  if (!node || typeof node !== "object") {
    return found;
  }
  const record = node as JsonSchema;
  if (record.type === "object") {
    found.push(record);
  }
  for (const value of Object.values(record)) {
    collectObjectNodes(value, found);
  }
  return found;
}

interface ContractPair {
  name: string;
  zod: { safeParse(input: unknown): { success: boolean } };
  json: JsonSchema;
  validSamples: unknown[];
  invalidSamples: unknown[];
}

const task = {
  id: "task-1",
  title: "title",
  description: "description",
  dependsOn: [],
  ownedPaths: ["src"],
  acceptanceCommands: [{ command: "pnpm", args: ["test"] }],
  profile: null,
};

const contracts: ContractPair[] = [
  {
    name: "goalIntake",
    zod: goalIntakeSchema,
    json: goalIntakeJsonSchema,
    validSamples: [
      { goalSummary: "g", instructionsForArchitect: "i", constraints: [], risk: "low" },
      { goalSummary: "g", instructionsForArchitect: "i", constraints: ["c"], risk: "high" },
    ],
    invalidSamples: [
      { instructionsForArchitect: "i", constraints: [], risk: "low" },
      { goalSummary: "", instructionsForArchitect: "i", constraints: [], risk: "low" },
      { goalSummary: "g", instructionsForArchitect: "i", constraints: [], risk: "extreme" },
      { goalSummary: "g", instructionsForArchitect: "i", constraints: "nope", risk: "low" },
    ],
  },
  {
    name: "taskPlan",
    zod: taskPlanSchema,
    json: taskPlanJsonSchema,
    validSamples: [
      { summary: "s", tasks: [task] },
      // args carries a zod default: omittable in both validators.
      { summary: "s", tasks: [{ ...task, acceptanceCommands: [{ command: "pnpm" }] }] },
      // batchKey is optional-nullable.
      { summary: "s", tasks: [{ ...task, batchKey: "wave-1" }] },
    ],
    invalidSamples: [
      { summary: "s", tasks: [] },
      { tasks: [task] },
      { summary: "s", tasks: [{ ...task, id: "-bad" }] },
      { summary: "s", tasks: [{ ...task, ownedPaths: [] }] },
      { summary: "s", tasks: [{ ...task, profile: 42 }] },
      { summary: "s", tasks: [{ ...task, batchKey: "x".repeat(65) }] },
      { summary: "s", tasks: [{ ...task, acceptanceCommands: [{ args: [] }] }] },
    ],
  },
  {
    name: "exploreSummary",
    zod: exploreSummarySchema,
    json: exploreSummaryJsonSchema,
    validSamples: [
      // 带 default 的数组字段在两侧都应可省略（手写 schema 曾把它们误列 required）。
      { summary: "s" },
      {
        summary: "s",
        modules: ["m"],
        riskPaths: [],
        suggestedAcceptanceCommands: [],
        forbiddenPaths: [],
        notes: ["n"],
      },
    ],
    invalidSamples: [
      {},
      { summary: "" },
      { summary: "s", modules: "nope" },
      { summary: "s", notes: [1] },
    ],
  },
  {
    name: "reviewVerdict",
    zod: reviewVerdictSchema,
    json: reviewVerdictJsonSchema,
    validSamples: [
      { verdict: "approve", summary: "s", findings: [] },
      {
        verdict: "request_changes",
        summary: "s",
        findings: [
          { severity: "high", path: "src/a.ts", line: 3, message: "m", required: true },
          { severity: "low", path: "src/b.ts", line: null, message: "m", required: false },
        ],
      },
    ],
    invalidSamples: [
      { verdict: "comment", summary: "s", findings: [] },
      { verdict: "approve", findings: [] },
      {
        verdict: "approve",
        summary: "s",
        findings: [{ severity: "info", path: "a", line: null, message: "m", required: true }],
      },
      {
        verdict: "approve",
        summary: "s",
        findings: [{ severity: "low", path: "a", line: 0, message: "m", required: true }],
      },
      {
        verdict: "approve",
        summary: "s",
        findings: [{ severity: "low", path: "a", line: 1.5, message: "m", required: true }],
      },
    ],
  },
  {
    name: "testVerdict",
    zod: testVerdictSchema,
    json: testVerdictJsonSchema,
    validSamples: [{ verdict: "escalate", summary: "s", missingTests: [] }],
    invalidSamples: [
      { verdict: "escalate", summary: "s" },
      { verdict: "pass", summary: "s", missingTests: [] },
    ],
  },
  {
    name: "finalDecision",
    zod: finalDecisionSchema,
    json: finalDecisionJsonSchema,
    validSamples: [
      { decision: "ready", reason: "r" },
      { decision: "escalate", reason: "r" },
    ],
    invalidSamples: [
      { decision: "maybe", reason: "r" },
      { decision: "ready", reason: "" },
      { decision: "ready" },
    ],
  },
];

describe("generated JSON schemas stay coherent with the zod contracts", () => {
  for (const contract of contracts) {
    describe(contract.name, () => {
      it("accepts every valid sample in both validators", () => {
        for (const sample of contract.validSamples) {
          expect(contract.zod.safeParse(sample).success).toBe(true);
          expect(validateJsonSchema(sample, contract.json)).toBe(true);
        }
      });

      it("rejects every invalid sample in both validators", () => {
        for (const sample of contract.invalidSamples) {
          expect(contract.zod.safeParse(sample).success).toBe(false);
          expect(validateJsonSchema(sample, contract.json)).toBe(false);
        }
      });
    });
  }

  it("emits bare schema objects without a $schema marker (CLI-compatible)", () => {
    for (const contract of contracts) {
      expect(contract.json).not.toHaveProperty("$schema");
    }
  });

  it("keeps additionalProperties: false on every object node", () => {
    for (const contract of contracts) {
      const objects = collectObjectNodes(contract.json);
      expect(objects.length).toBeGreaterThan(0);
      for (const node of objects) {
        expect(node.additionalProperties).toBe(false);
      }
    }
  });

  it("never lists a defaulted property as required (zod input semantics)", () => {
    const explore = exploreSummaryJsonSchema;
    expect(explore.required).toEqual(["summary"]);
    const commandItems = (
      ((taskPlanJsonSchema.properties as JsonSchema).tasks as JsonSchema).items as JsonSchema
    );
    const commands = ((commandItems.properties as JsonSchema).acceptanceCommands as JsonSchema)
      .items as JsonSchema;
    expect(commands.required).toEqual(["command"]);
  });

  it("documents the one intentional asymmetry: zod strips unknown keys, the JSON schema forbids them", () => {
    const withExtra = {
      goalSummary: "g",
      instructionsForArchitect: "i",
      constraints: [],
      risk: "low",
      unexpected: true,
    };
    expect(goalIntakeSchema.safeParse(withExtra).success).toBe(true);
    expect(validateJsonSchema(withExtra, goalIntakeJsonSchema)).toBe(false);
  });
});
