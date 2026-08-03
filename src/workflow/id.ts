import { randomUUID } from "node:crypto";

export function createRunId(goal: string, now = new Date()): string {
  const date = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 28) || "goal";
  return `${date}-${slug}-${randomUUID().slice(0, 6)}`;
}

export function branchSegment(value: string): string {
  const segment = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  if (!segment) {
    throw new Error(`Cannot derive a safe branch segment from '${value}'`);
  }
  return segment;
}
