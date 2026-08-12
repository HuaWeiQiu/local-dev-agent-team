export const goalIntakeJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["goalSummary", "instructionsForArchitect", "constraints", "risk"],
  properties: {
    goalSummary: { type: "string" },
    instructionsForArchitect: { type: "string" },
    constraints: { type: "array", items: { type: "string" } },
    risk: { enum: ["low", "medium", "high"] },
  },
};

const commandJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["command", "args"],
  properties: {
    command: { type: "string" },
    args: { type: "array", items: { type: "string" } },
  },
};

export const taskPlanJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "tasks"],
  properties: {
    summary: { type: "string" },
    tasks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "title",
          "description",
          "dependsOn",
          "ownedPaths",
          "acceptanceCommands",
          "profile",
        ],
        properties: {
          id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" },
          title: { type: "string" },
          description: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
          ownedPaths: { type: "array", minItems: 1, items: { type: "string" } },
          acceptanceCommands: { type: "array", items: commandJsonSchema },
          profile: { type: ["string", "null"] },
          batchKey: { type: ["string", "null"] },
        },
      },
    },
  },
};

export const exploreSummaryJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "modules", "riskPaths", "suggestedAcceptanceCommands", "forbiddenPaths", "notes"],
  properties: {
    summary: { type: "string" },
    modules: { type: "array", items: { type: "string" } },
    riskPaths: { type: "array", items: { type: "string" } },
    suggestedAcceptanceCommands: { type: "array", items: { type: "string" } },
    forbiddenPaths: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: { type: "string" } },
  },
};

const findingJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["severity", "path", "line", "message", "required"],
  properties: {
    severity: { enum: ["critical", "high", "medium", "low"] },
    path: { type: "string" },
    line: { type: ["integer", "null"], minimum: 1 },
    message: { type: "string" },
    required: { type: "boolean" },
  },
};

export const reviewVerdictJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { enum: ["approve", "request_changes", "escalate"] },
    summary: { type: "string" },
    findings: { type: "array", items: findingJsonSchema },
  },
};

export const testVerdictJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "missingTests"],
  properties: {
    verdict: { enum: ["approve", "request_changes", "escalate"] },
    summary: { type: "string" },
    missingTests: { type: "array", items: { type: "string" } },
  },
};

export const finalDecisionJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "reason"],
  properties: {
    decision: { enum: ["ready", "escalate"] },
    reason: { type: "string" },
  },
};
