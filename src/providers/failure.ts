/**
 * Stable provider/model failure classification for profile invocation and
 * automatic evolution. Infrastructure failures must not be treated as strategy
 * quality regressions.
 */

export const PROVIDER_FAILURE_CODES = [
  "MODEL_QUOTA_EXHAUSTED",
  "MODEL_RATE_LIMITED",
  "MODEL_AUTH_FAILED",
  "MODEL_UNAVAILABLE",
  "MODEL_NETWORK_ERROR",
  "MODEL_NOT_FOUND",
  "MODEL_PROCESS_ERROR",
  "MODEL_OUTPUT_INVALID",
  "MODEL_UNKNOWN",
] as const;

export type ProviderFailureCode = (typeof PROVIDER_FAILURE_CODES)[number];

export type ProviderFailureCategory =
  | "quota"
  | "rate-limit"
  | "auth"
  | "availability"
  | "network"
  | "configuration"
  | "process"
  | "output"
  | "unknown";

export type ProviderCircuitState = "closed" | "open" | "half-open";

export interface ProviderFailureClassification {
  code: ProviderFailureCode;
  category: ProviderFailureCategory;
  /** Infrastructure issues that must not count as strategy quality loss. */
  infrastructure: boolean;
  /** When true, automatic evolution should pause instead of consuming cycles. */
  pauseEvolution: boolean;
  retryable: boolean;
  /** Suggested backoff before the next probe of the same profile/provider. */
  backoffMs: number;
  summary: string;
  signals: string[];
}

export interface ClassifyProviderFailureInput {
  message?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  signal?: string | null;
  errno?: string;
  cause?: unknown;
}

export class ProviderFailureError extends Error {
  override readonly name = "ProviderFailureError";

  constructor(
    message: string,
    readonly classification: ProviderFailureClassification,
    readonly profile?: string,
    readonly adapter?: string,
    readonly model?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  get code(): ProviderFailureCode {
    return this.classification.code;
  }
}

export class RoleProfileChainError extends Error {
  override readonly name = "RoleProfileChainError";

  constructor(
    readonly role: string,
    readonly attempts: ProviderFailureAttempt[],
    options?: ErrorOptions,
  ) {
    super(formatChainMessage(role, attempts), options);
  }

  get primaryClassification(): ProviderFailureClassification | undefined {
    return this.attempts[0]?.classification;
  }

  get infrastructure(): boolean {
    return this.attempts.some((attempt) => attempt.classification.infrastructure);
  }

  get pauseEvolution(): boolean {
    return this.attempts.some((attempt) => attempt.classification.pauseEvolution);
  }

  get codes(): ProviderFailureCode[] {
    return this.attempts.map((attempt) => attempt.classification.code);
  }
}

export interface ProviderFailureAttempt {
  profile: string;
  adapter: string;
  model: string;
  classification: ProviderFailureClassification;
  message: string;
  at: string;
}

export interface ProviderHealthSnapshot {
  key: string;
  profile: string;
  adapter: string;
  model: string;
  state: ProviderCircuitState;
  lastCode: ProviderFailureCode | null;
  lastSummary: string | null;
  failureCount: number;
  successCount: number;
  openedAt: string | null;
  nextProbeAt: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
}

const categoryByCode: Record<ProviderFailureCode, ProviderFailureCategory> = {
  MODEL_QUOTA_EXHAUSTED: "quota",
  MODEL_RATE_LIMITED: "rate-limit",
  MODEL_AUTH_FAILED: "auth",
  MODEL_UNAVAILABLE: "availability",
  MODEL_NETWORK_ERROR: "network",
  MODEL_NOT_FOUND: "configuration",
  MODEL_PROCESS_ERROR: "process",
  MODEL_OUTPUT_INVALID: "output",
  MODEL_UNKNOWN: "unknown",
};

const defaultBackoffMs: Record<ProviderFailureCode, number> = {
  MODEL_QUOTA_EXHAUSTED: 15 * 60_000,
  MODEL_RATE_LIMITED: 60_000,
  MODEL_AUTH_FAILED: 10 * 60_000,
  MODEL_UNAVAILABLE: 2 * 60_000,
  MODEL_NETWORK_ERROR: 30_000,
  MODEL_NOT_FOUND: 5 * 60_000,
  MODEL_PROCESS_ERROR: 15_000,
  MODEL_OUTPUT_INVALID: 0,
  MODEL_UNKNOWN: 15_000,
};

const infrastructureCodes = new Set<ProviderFailureCode>([
  "MODEL_QUOTA_EXHAUSTED",
  "MODEL_RATE_LIMITED",
  "MODEL_AUTH_FAILED",
  "MODEL_UNAVAILABLE",
  "MODEL_NETWORK_ERROR",
  "MODEL_NOT_FOUND",
  "MODEL_PROCESS_ERROR",
]);

const pauseEvolutionCodes = new Set<ProviderFailureCode>([
  "MODEL_QUOTA_EXHAUSTED",
  "MODEL_AUTH_FAILED",
  "MODEL_UNAVAILABLE",
  "MODEL_NETWORK_ERROR",
  "MODEL_NOT_FOUND",
]);

interface PatternRule {
  code: ProviderFailureCode;
  patterns: RegExp[];
}

const rules: PatternRule[] = [
  {
    code: "MODEL_QUOTA_EXHAUSTED",
    patterns: [
      /\bquota\b/i,
      /\binufficient[_\s-]?quota\b/i,
      /\binsufficient[_\s-]?quota\b/i,
      /\bbilling\b/i,
      /\bexceeded[_\s-]?your[_\s-]?current[_\s-]?quota\b/i,
      /\btoken[_\s-]?limit\b/i,
      /\busage[_\s-]?limit\b/i,
      /\bout of credits\b/i,
      /\bno credits\b/i,
      /\bcredit balance\b/i,
      /\bspend limit\b/i,
      /\bmonthly limit\b/i,
      /\b429\b.*\bquota\b/i,
      /\bresource[_\s-]?exhausted\b/i,
    ],
  },
  {
    code: "MODEL_RATE_LIMITED",
    patterns: [
      /\brate[_\s-]?limit/i,
      /\btoo many requests\b/i,
      /\b429\b/,
      /\bthrottl/i,
      /\bretry[_\s-]?after\b/i,
      /\bslow down\b/i,
      /\brequests per (minute|second|day)\b/i,
    ],
  },
  {
    code: "MODEL_AUTH_FAILED",
    patterns: [
      /\bunauthorized\b/i,
      /\bunauthenticated\b/i,
      /\bauthentication (failed|required|error)\b/i,
      /\bnot authenticated\b/i,
      /\binvalid[_\s-]?(api[_\s-]?key|token|credentials)\b/i,
      /\bexpired[_\s-]?(api[_\s-]?key|token|credentials)\b/i,
      /\blogin required\b/i,
      /\bplease log in\b/i,
      /\bauth(?:entication)? failed\b/i,
      /\b401\b/,
      /\b403\b/,
      /\bforbidden\b/i,
      /\baccess denied\b/i,
      /\bmissing[_\s-]?(api[_\s-]?key|token|credentials)\b/i,
    ],
  },
  {
    code: "MODEL_NOT_FOUND",
    patterns: [
      /\bmodel[_\s-]?(not found|does not exist|unavailable|unknown)\b/i,
      /\binvalid model\b/i,
      /\bunknown model\b/i,
      /\bno such model\b/i,
      /\bmodel_not_found\b/i,
    ],
  },
  {
    code: "MODEL_NETWORK_ERROR",
    patterns: [
      /\bECONNRESET\b/,
      /\bECONNREFUSED\b/,
      /\bENOTFOUND\b/,
      /\bETIMEDOUT\b/,
      /\bEAI_AGAIN\b/,
      /\bENETUNREACH\b/,
      /\bsocket hang up\b/i,
      /\bnetwork (error|unreachable|timeout)\b/i,
      /\bfetch failed\b/i,
      /\bconnection (reset|refused|timed out|timeout)\b/i,
      /\bDNS\b/,
      /\bTLS\b/,
      /\bSSL\b/,
      /\bcertificate\b/i,
      /\bproxy error\b/i,
    ],
  },
  {
    code: "MODEL_UNAVAILABLE",
    patterns: [
      /\bservice unavailable\b/i,
      /\btemporarily unavailable\b/i,
      /\boverloaded\b/i,
      /\bcapacity\b/i,
      /\bupstream\b/i,
      /\b502\b/,
      /\b503\b/,
      /\b504\b/,
      /\bserver error\b/i,
      /\binternal server error\b/i,
      /\bprovider error\b/i,
      /\bengine (offline|unavailable)\b/i,
    ],
  },
  {
    code: "MODEL_PROCESS_ERROR",
    patterns: [
      /\bENOENT\b/,
      /\bnot found\b/i,
      /\bspawn\b/i,
      /\bcommand not found\b/i,
      /\bexecutable\b/i,
      /\bexited with\b/i,
      /\bsignal\b/i,
      /\btimed? ?out\b/i,
      /\bkilled\b/i,
    ],
  },
  {
    code: "MODEL_OUTPUT_INVALID",
    patterns: [
      /\binvalid (json|structured) output\b/i,
      /\bcould not be parsed\b/i,
      /\boutput was not valid json\b/i,
      /\binvalid structured output\b/i,
      /\breturned no (json|completion)\b/i,
    ],
  },
];

export function classifyProviderFailure(
  input: ClassifyProviderFailureInput,
): ProviderFailureClassification {
  const signals: string[] = [];
  const blobs = [
    input.message,
    input.stdout,
    input.stderr,
    input.errno,
    input.signal,
    input.timedOut ? "timed out" : undefined,
    input.exitCode !== undefined && input.exitCode !== null
      ? `exitCode=${input.exitCode}`
      : undefined,
    errorChainText(input.cause),
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join("\n");

  if (input.timedOut) signals.push("timedOut");
  if (input.errno) signals.push(`errno:${input.errno}`);
  if (input.exitCode !== undefined && input.exitCode !== null && input.exitCode !== 0) {
    signals.push(`exitCode:${input.exitCode}`);
  }
  if (input.signal) signals.push(`signal:${input.signal}`);

  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      if (pattern.test(blobs)) {
        signals.push(`pattern:${pattern.source}`);
        return buildClassification(rule.code, signals);
      }
    }
  }

  if (input.exitCode === 127 || input.errno === "ENOENT") {
    signals.push("missing-executable");
    return buildClassification("MODEL_PROCESS_ERROR", signals);
  }
  if (input.timedOut) {
    return buildClassification("MODEL_PROCESS_ERROR", signals);
  }
  if (input.exitCode !== undefined && input.exitCode !== null && input.exitCode !== 0) {
    return buildClassification("MODEL_PROCESS_ERROR", signals);
  }
  return buildClassification("MODEL_UNKNOWN", signals.length > 0 ? signals : ["unclassified"]);
}

export function classifyError(error: unknown): ProviderFailureClassification {
  if (error instanceof ProviderFailureError) return error.classification;
  if (error instanceof RoleProfileChainError) {
    return (
      error.primaryClassification ??
      buildClassification("MODEL_UNKNOWN", ["empty-chain"])
    );
  }
  if (error instanceof Error && "code" in error && error.code === "RUN_BUDGET_EXCEEDED") {
    return buildClassification("MODEL_PROCESS_ERROR", ["run-budget-exceeded"]);
  }

  const message = error instanceof Error ? error.message : String(error);
  const errno =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  return classifyProviderFailure({
    message,
    ...(errno ? { errno } : {}),
    cause: error instanceof Error ? error.cause : undefined,
  });
}

export function classificationForCode(
  code: ProviderFailureCode,
  signals: string[] = ["explicit-code"],
): ProviderFailureClassification {
  return buildClassification(code, signals);
}

export function healthKey(profile: string, adapter: string, model: string): string {
  return `${adapter}::${profile}::${model}`;
}

export class ProviderHealthRegistry {
  private readonly entries = new Map<string, MutableHealth>();

  constructor(private readonly now: () => number = Date.now) {}

  recordSuccess(profile: string, adapter: string, model: string): ProviderHealthSnapshot {
    const key = healthKey(profile, adapter, model);
    const entry = this.ensure(key, profile, adapter, model);
    entry.state = "closed";
    entry.successCount += 1;
    entry.failureCount = 0;
    entry.lastCode = null;
    entry.lastSummary = null;
    entry.openedAtMs = null;
    entry.nextProbeAtMs = null;
    entry.lastSuccessAtMs = this.now();
    return this.snapshotOf(entry);
  }

  recordFailure(
    profile: string,
    adapter: string,
    model: string,
    classification: ProviderFailureClassification,
  ): ProviderHealthSnapshot {
    const key = healthKey(profile, adapter, model);
    const entry = this.ensure(key, profile, adapter, model);
    entry.failureCount += 1;
    entry.lastCode = classification.code;
    entry.lastSummary = classification.summary;
    entry.lastFailureAtMs = this.now();
    if (classification.backoffMs > 0) {
      entry.state = "open";
      entry.openedAtMs = this.now();
      entry.nextProbeAtMs = this.now() + classification.backoffMs;
    }
    return this.snapshotOf(entry);
  }

  /**
   * Returns whether a profile may be invoked now. Open circuits stay blocked
   * until nextProbeAt; then a single half-open probe is allowed.
   */
  allowAttempt(profile: string, adapter: string, model: string): {
    allowed: boolean;
    snapshot: ProviderHealthSnapshot;
    reason?: string;
  } {
    const key = healthKey(profile, adapter, model);
    const entry = this.ensure(key, profile, adapter, model);
    if (entry.state === "closed") {
      return { allowed: true, snapshot: this.snapshotOf(entry) };
    }
    if (entry.state === "open") {
      if (entry.nextProbeAtMs !== null && this.now() >= entry.nextProbeAtMs) {
        entry.state = "half-open";
        return {
          allowed: true,
          snapshot: this.snapshotOf(entry),
          reason: "recovery-probe",
        };
      }
      const waitMs =
        entry.nextProbeAtMs === null ? 0 : Math.max(0, entry.nextProbeAtMs - this.now());
      return {
        allowed: false,
        snapshot: this.snapshotOf(entry),
        reason: `circuit open until ${this.snapshotOf(entry).nextProbeAt ?? "unknown"} (${waitMs}ms)`,
      };
    }
    // half-open: allow the probe currently in flight only once; subsequent concurrent
    // callers still see half-open and may also probe — registry is single-process local.
    return { allowed: true, snapshot: this.snapshotOf(entry), reason: "half-open" };
  }

  list(): ProviderHealthSnapshot[] {
    return [...this.entries.values()]
      .map((entry) => this.snapshotOf(entry))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  get(profile: string, adapter: string, model: string): ProviderHealthSnapshot | undefined {
    const entry = this.entries.get(healthKey(profile, adapter, model));
    return entry ? this.snapshotOf(entry) : undefined;
  }

  clear(): void {
    this.entries.clear();
  }

  private ensure(
    key: string,
    profile: string,
    adapter: string,
    model: string,
  ): MutableHealth {
    const existing = this.entries.get(key);
    if (existing) return existing;
    const created: MutableHealth = {
      key,
      profile,
      adapter,
      model,
      state: "closed",
      lastCode: null,
      lastSummary: null,
      failureCount: 0,
      successCount: 0,
      openedAtMs: null,
      nextProbeAtMs: null,
      lastFailureAtMs: null,
      lastSuccessAtMs: null,
    };
    this.entries.set(key, created);
    return created;
  }

  private snapshotOf(entry: MutableHealth): ProviderHealthSnapshot {
    return {
      key: entry.key,
      profile: entry.profile,
      adapter: entry.adapter,
      model: entry.model,
      state: entry.state,
      lastCode: entry.lastCode,
      lastSummary: entry.lastSummary,
      failureCount: entry.failureCount,
      successCount: entry.successCount,
      openedAt: entry.openedAtMs === null ? null : new Date(entry.openedAtMs).toISOString(),
      nextProbeAt:
        entry.nextProbeAtMs === null ? null : new Date(entry.nextProbeAtMs).toISOString(),
      lastFailureAt:
        entry.lastFailureAtMs === null ? null : new Date(entry.lastFailureAtMs).toISOString(),
      lastSuccessAt:
        entry.lastSuccessAtMs === null ? null : new Date(entry.lastSuccessAtMs).toISOString(),
    };
  }
}

/** Process-local registry shared by agent invocations in one control service. */
export const defaultProviderHealthRegistry = new ProviderHealthRegistry();

function buildClassification(
  code: ProviderFailureCode,
  signals: string[],
): ProviderFailureClassification {
  return {
    code,
    category: categoryByCode[code],
    infrastructure: infrastructureCodes.has(code),
    pauseEvolution: pauseEvolutionCodes.has(code),
    retryable: code !== "MODEL_AUTH_FAILED" && code !== "MODEL_NOT_FOUND",
    backoffMs: defaultBackoffMs[code],
    summary: summaryFor(code),
    signals,
  };
}

function summaryFor(code: ProviderFailureCode): string {
  switch (code) {
    case "MODEL_QUOTA_EXHAUSTED":
      return "Model provider quota or credits are exhausted";
    case "MODEL_RATE_LIMITED":
      return "Model provider rate-limited the request";
    case "MODEL_AUTH_FAILED":
      return "Model provider authentication failed";
    case "MODEL_UNAVAILABLE":
      return "Model provider is temporarily unavailable";
    case "MODEL_NETWORK_ERROR":
      return "Network error while contacting the model provider";
    case "MODEL_NOT_FOUND":
      return "Configured model was not found by the provider";
    case "MODEL_PROCESS_ERROR":
      return "Local agent CLI process failed";
    case "MODEL_OUTPUT_INVALID":
      return "Agent returned invalid structured output";
    case "MODEL_UNKNOWN":
      return "Unclassified model or agent failure";
  }
}

function formatChainMessage(role: string, attempts: ProviderFailureAttempt[]): string {
  if (attempts.length === 0) {
    return `All profiles failed for role '${role}'`;
  }
  const lines = attempts.map(
    (attempt) =>
      `${attempt.profile}: [${attempt.classification.code}] ${attempt.message}`,
  );
  return `All profiles failed for role '${role}':\n${lines.join("\n")}`;
}

function errorChainText(cause: unknown, depth = 0): string {
  if (!cause || depth > 3) return "";
  if (cause instanceof Error) {
    const nested = cause.cause ? errorChainText(cause.cause, depth + 1) : "";
    return [cause.message, nested].filter(Boolean).join("\n");
  }
  return String(cause);
}

interface MutableHealth {
  key: string;
  profile: string;
  adapter: string;
  model: string;
  state: ProviderCircuitState;
  lastCode: ProviderFailureCode | null;
  lastSummary: string | null;
  failureCount: number;
  successCount: number;
  openedAtMs: number | null;
  nextProbeAtMs: number | null;
  lastFailureAtMs: number | null;
  lastSuccessAtMs: number | null;
}
