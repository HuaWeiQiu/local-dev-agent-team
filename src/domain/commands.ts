import { z } from "zod";

/**
 * Atomic command specification shared by config (quality commands), evaluation
 * suites, and task contracts. Lives in the domain leaf package so downstream
 * packages never need to value-import the config package for it.
 */
export const commandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});

export type CommandSpec = z.infer<typeof commandSchema>;
