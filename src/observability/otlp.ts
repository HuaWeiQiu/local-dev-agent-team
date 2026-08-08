import type { RunEvent } from "../events/types.js";

export function buildOtlpTraceExport(
  events: RunEvent[],
  projectName: string,
): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attribute("service.name", "local-dev-agent-team"),
            attribute("service.version", "0.1.0"),
            attribute("agent_team.project.name", projectName),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "local-dev-agent-team.events", version: "0.1.0" },
            spans: events.map(eventSpan),
          },
        ],
      },
    ],
  };
}

function eventSpan(event: RunEvent): Record<string, unknown> {
  const payload = isRecord(event.payload) ? event.payload : {};
  const durationMs = numberValue(payload.durationMs) ?? 0;
  const endMs = Date.parse(event.occurredAt);
  const safeEndMs = Number.isFinite(endMs) ? Math.max(0, Math.trunc(endMs)) : 0;
  const safeStartMs = Math.max(0, Math.trunc(safeEndMs - durationMs));
  const failed = payload.success === false || event.type.endsWith(".crashed");
  const attributes = [
    attribute("agent_team.run.id", event.runId),
    attribute("agent_team.event.id", event.id),
    attribute("agent_team.event.sequence", event.sequence),
    attribute("agent_team.event.type", event.type),
  ];
  addPayloadAttribute(attributes, payload, "role", "gen_ai.agent.name");
  addPayloadAttribute(attributes, payload, "adapter", "gen_ai.provider.name");
  addPayloadAttribute(attributes, payload, "model", "gen_ai.request.model");
  addPayloadAttribute(attributes, payload, "profile", "agent_team.profile.name");
  addPayloadAttribute(attributes, payload, "permission", "agent_team.permission");
  addPayloadAttribute(attributes, payload, "externalTools", "agent_team.external_tools");
  addPayloadAttribute(attributes, payload, "artifactKey", "agent_team.artifact.key");
  addPayloadAttribute(attributes, payload, "stdoutBytes", "process.io.stdout.bytes");
  addPayloadAttribute(attributes, payload, "stderrBytes", "process.io.stderr.bytes");
  if (event.type.startsWith("agent.invocation.")) {
    attributes.push(attribute("gen_ai.operation.name", "invoke_agent"));
  }
  const usage = isRecord(payload.usage) ? payload.usage : undefined;
  addPayloadAttribute(attributes, usage, "inputTokens", "gen_ai.usage.input_tokens");
  addPayloadAttribute(attributes, usage, "outputTokens", "gen_ai.usage.output_tokens");

  return {
    traceId: event.traceId,
    spanId: event.spanId,
    name: event.type.startsWith("agent.invocation.") ? "invoke_agent" : event.type,
    kind: 1,
    startTimeUnixNano: String(BigInt(safeStartMs) * 1_000_000n),
    endTimeUnixNano: String(BigInt(safeEndMs) * 1_000_000n),
    attributes,
    status: failed
      ? { code: 2, message: stringValue(payload.error) ?? "operation failed" }
      : { code: 1 },
  };
}

function addPayloadAttribute(
  attributes: Array<Record<string, unknown>>,
  payload: Record<string, unknown> | undefined,
  source: string,
  target: string,
): void {
  const value = payload?.[source];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    attributes.push(attribute(target, value));
  }
}

function attribute(key: string, value: string | number | boolean): Record<string, unknown> {
  return {
    key,
    value:
      typeof value === "string"
        ? { stringValue: value }
        : typeof value === "boolean"
          ? { boolValue: value }
          : Number.isInteger(value)
            ? { intValue: String(value) }
            : { doubleValue: value },
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
