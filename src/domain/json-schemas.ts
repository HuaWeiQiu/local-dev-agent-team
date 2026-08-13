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
 * Two post-processing steps keep the emitted draft CLI-compatible:
 * - the draft-2020-12 `$schema` marker is dropped;
 * - every object `properties` key is listed in `required`. Codex / OpenAI
 *   structured output rejects schemas that omit a property from `required`
 *   (for example `acceptanceCommands.items.args` after a zod `.default()`).
 * Zod still applies defaults when parsing the model payload.
 */
function toCliJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema) as Record<string, unknown>;
  delete generated.$schema;
  requireAllObjectProperties(generated);
  return generated;
}

function requireAllObjectProperties(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      requireAllObjectProperties(item);
    }
    return;
  }
  if (!node || typeof node !== "object") {
    return;
  }
  const record = node as Record<string, unknown>;
  const properties = record.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    record.required = Object.keys(properties as Record<string, unknown>);
  }
  for (const value of Object.values(record)) {
    requireAllObjectProperties(value);
  }
}

export const goalIntakeJsonSchema: Record<string, unknown> = toCliJsonSchema(goalIntakeSchema);

export const taskPlanJsonSchema: Record<string, unknown> = toCliJsonSchema(taskPlanSchema);

export const exploreSummaryJsonSchema: Record<string, unknown> = toCliJsonSchema(exploreSummarySchema);

export const reviewVerdictJsonSchema: Record<string, unknown> = toCliJsonSchema(reviewVerdictSchema);

export const testVerdictJsonSchema: Record<string, unknown> = toCliJsonSchema(testVerdictSchema);

export const finalDecisionJsonSchema: Record<string, unknown> = toCliJsonSchema(finalDecisionSchema);
