import { z } from "zod";
import {
  exploreSummarySchema,
  finalDecisionSchema,
  goalIntakeSchema,
  reviewVerdictSchema,
  taskPlanSchema,
  testVerdictSchema,
} from "./contracts.js";

/**
 * Structured-output JSON Schemas sent to agent CLIs, generated from the zod
 * contracts in contracts.ts so the two can no longer drift apart.
 *
 * Two minimal post-processing steps keep the emitted draft close to the
 * hand-written schemas the CLIs were validated against:
 * - the draft-2020-12 `$schema` marker is dropped; CLIs receive a bare schema
 *   object (the previous hand-written schemas had no `$schema` either);
 * - properties carrying a zod `.default()` are removed from `required`, because
 *   zod treats them as optional on input and fills the default. The previous
 *   hand-written exploreSummary schema incorrectly listed its defaulted array
 *   fields as required; the zod semantics are authoritative here.
 */
function toCliJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema) as Record<string, unknown>;
  delete generated.$schema;
  unrequireDefaultedProperties(generated);
  return generated;
}

function unrequireDefaultedProperties(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      unrequireDefaultedProperties(item);
    }
    return;
  }
  if (!node || typeof node !== "object") {
    return;
  }
  const record = node as Record<string, unknown>;
  const properties = record.properties;
  if (Array.isArray(record.required) && properties && typeof properties === "object") {
    const declarations = properties as Record<string, unknown>;
    record.required = record.required.filter((key) => {
      const declaration = declarations[key as string];
      return !(
        declaration &&
        typeof declaration === "object" &&
        "default" in (declaration as Record<string, unknown>)
      );
    });
  }
  for (const value of Object.values(record)) {
    unrequireDefaultedProperties(value);
  }
}

export const goalIntakeJsonSchema: Record<string, unknown> = toCliJsonSchema(goalIntakeSchema);

export const taskPlanJsonSchema: Record<string, unknown> = toCliJsonSchema(taskPlanSchema);

export const exploreSummaryJsonSchema: Record<string, unknown> = toCliJsonSchema(exploreSummarySchema);

export const reviewVerdictJsonSchema: Record<string, unknown> = toCliJsonSchema(reviewVerdictSchema);

export const testVerdictJsonSchema: Record<string, unknown> = toCliJsonSchema(testVerdictSchema);

export const finalDecisionJsonSchema: Record<string, unknown> = toCliJsonSchema(finalDecisionSchema);
