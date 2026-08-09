import type { RunEvent } from "../events/types.js";

export interface RunLogFilter {
  role?: string;
  typePrefix?: string;
  tail?: number;
}

const STREAM_EVENT_TYPES = new Map<string, string>([
  ["agent.stdout", "stdout"],
  ["agent.stderr", "stderr"],
]);

const MAX_DETAIL_VALUE_LENGTH = 80;
const MAX_DETAIL_LENGTH = 240;

export function eventRole(event: RunEvent): string | undefined {
  const role = asRecord(event.payload)?.role;
  return typeof role === "string" && role.length > 0 ? role : undefined;
}

export function filterRunEvents(events: RunEvent[], filter: RunLogFilter): RunEvent[] {
  let filtered = events;
  if (filter.role !== undefined) {
    filtered = filtered.filter((event) => eventRole(event) === filter.role);
  }
  if (filter.typePrefix !== undefined) {
    const prefix = filter.typePrefix;
    filtered = filtered.filter((event) => event.type.startsWith(prefix));
  }
  if (filter.tail !== undefined && filter.tail < filtered.length) {
    filtered = filtered.slice(filtered.length - filter.tail);
  }
  return filtered;
}

export function renderLogLines(events: RunEvent[]): string[] {
  const lines: string[] = [];
  for (const event of events) {
    const stream = STREAM_EVENT_TYPES.get(event.type);
    if (stream) {
      const payload = asRecord(event.payload);
      const chunk = typeof payload?.chunk === "string" ? payload.chunk : "";
      if (chunk.length === 0) continue;
      const role = typeof payload?.role === "string" ? payload.role : "unknown";
      const prefix = `[${role} ${stream}] `;
      const parts = chunk.replaceAll("\r\n", "\n").split("\n");
      if (parts.at(-1) === "") {
        parts.pop();
      }
      for (const part of parts) {
        lines.push(prefix + part);
      }
      continue;
    }
    const detail = lifecycleDetail(event.payload);
    lines.push(detail ? `[${event.type}] ${detail}` : `[${event.type}]`);
  }
  return lines;
}

export function lifecycleDetail(payload: unknown): string {
  if (payload === undefined) return "";
  const record = asRecord(payload);
  if (!record) {
    return summarizeText(JSON.stringify(payload));
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    const rendered = renderDetailValue(value);
    if (rendered === undefined) continue;
    parts.push(`${key}=${rendered}`);
  }
  if (parts.length === 0) return "";
  let detail = parts.join(" ");
  if (detail.length > MAX_DETAIL_LENGTH) {
    detail = `${detail.slice(0, MAX_DETAIL_LENGTH - 3)}...`;
  }
  return detail;
}

function renderDetailValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "null";
  if (typeof value === "string") return summarizeText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return summarizeText(JSON.stringify(value));
}

function summarizeText(value: string): string {
  const flattened = value.replaceAll(/\s+/g, " ").trim();
  if (flattened.length <= MAX_DETAIL_VALUE_LENGTH) return flattened;
  return `${flattened.slice(0, MAX_DETAIL_VALUE_LENGTH - 3)}...`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
