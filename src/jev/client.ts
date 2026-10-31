import type { JevConfig } from "../config/schema.js";
import {
  jevDecisionSchema,
  type ForkAdvisor,
  type JevDecision,
  type JevDecisionInput,
} from "./policy.js";

const MAX_FAILURE_CHARS = 1_500;

const SYSTEM_PROMPT = [
  "You are a fast routing model inside a software-development orchestrator.",
  "A coding task just failed its deterministic checks. Decide the next step:",
  '- "retry": the failure looks new or easy to fix; let the worker try again directly.',
  '- "consult": the worker is likely stuck in a loop or the cause is unclear; ask the senior architect first.',
  "You cannot approve work or override failing checks.",
  'Reply with one JSON object only: {"decision":"retry"|"consult","confidence":0..1,"reason":"short"}.',
  "confidence is how sure you are; use a low value when unsure.",
].join("\n");

export type JevProbeResult =
  | { ok: true; latencyMs: number; decision: JevDecision }
  | { ok: false; latencyMs: number; error: string };

type RequestOutcome = { decision: JevDecision } | { error: string };

const PROBE_INPUT: JevDecisionInput = {
  taskId: "probe",
  taskTitle: "Connectivity probe",
  attempt: 2,
  maxAttempts: 3,
  repeated: true,
  failureSummary: "pnpm test exited 1: AssertionError expected 2 to equal 3 (same failure as the previous attempt)",
};

export class JevClient implements ForkAdvisor {
  constructor(
    private readonly config: Pick<JevConfig, "baseUrl" | "model" | "timeoutMs"> & {
      protocol?: JevConfig["protocol"];
    },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async decide(input: JevDecisionInput, signal?: AbortSignal): Promise<JevDecision | undefined> {
    const outcome = await this.request(input, signal);
    return "decision" in outcome ? outcome.decision : undefined;
  }

  /** Diagnostic round trip for the settings UI; reports why a call failed instead of swallowing it. */
  async probe(): Promise<JevProbeResult> {
    const startedAt = Date.now();
    const outcome = await this.request(PROBE_INPUT);
    const latencyMs = Date.now() - startedAt;
    return "decision" in outcome
      ? { ok: true, latencyMs, decision: outcome.decision }
      : { ok: false, latencyMs, error: outcome.error };
  }

  private async request(input: JevDecisionInput, signal?: AbortSignal): Promise<RequestOutcome> {
    return this.config.protocol === "laya" ? this.requestLaya(input, signal) : this.requestChat(input, signal);
  }

  private async requestLaya(input: JevDecisionInput, signal?: AbortSignal): Promise<RequestOutcome> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetchImpl(this.endpoint("decide"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: combined,
        body: JSON.stringify({
          model: this.config.model,
          state: JSON.stringify(renderInput(input)),
          questions: LAYA_QUESTIONS,
        }),
      });
      if (!response.ok) {
        return { error: `HTTP ${response.status}` };
      }
      const decision = parseLayaDecision(await response.json());
      return decision ? { decision } : { error: "响应缺少 answers.route 的 choice / confidence" };
    } catch (error) {
      if (timeout.aborted) {
        return { error: `超过 ${this.config.timeoutMs}ms 未响应` };
      }
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async requestChat(input: JevDecisionInput, signal?: AbortSignal): Promise<RequestOutcome> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetchImpl(this.endpoint("chat/completions"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: combined,
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          max_tokens: 160,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify(renderInput(input)) },
          ],
        }),
      });
      if (!response.ok) {
        return { error: `HTTP ${response.status}` };
      }
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        return { error: "响应缺少 choices[0].message.content" };
      }
      const decision = parseDecision(content);
      return decision
        ? { decision }
        : { error: `输出不是合法的决策 JSON:${content.slice(0, 160)}` };
    } catch (error) {
      if (timeout.aborted) {
        return { error: `超过 ${this.config.timeoutMs}ms 未响应` };
      }
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private endpoint(path: string): URL {
    const base = this.config.baseUrl.endsWith("/") ? this.config.baseUrl : `${this.config.baseUrl}/`;
    return new URL(path, base);
  }
}

function renderInput(input: JevDecisionInput): Record<string, unknown> {
  return {
    task: { id: input.taskId, title: input.taskTitle },
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    sameFailureAsPreviousAttempt: input.repeated,
    failure: input.failureSummary.slice(0, MAX_FAILURE_CHARS),
  };
}

/** Typed question for a decision classifier: one choice, scored per option in a single pass. */
const LAYA_QUESTIONS = {
  route: {
    type: "choice",
    instructions:
      "A coding task attempt failed its deterministic checks. Should the orchestrator retry directly, or consult the senior architect first?",
    criteria: {
      retry: "new, transient or easy failure: flaky test, timeout, typo, missing import, lint or format error, first attempt",
      consult:
        "stuck or design-level failure: same failure repeated, wrong approach, contract mismatch, conflicting requirements, unclear cause",
    },
  },
} as const;

export function parseLayaDecision(payload: unknown): JevDecision | undefined {
  const answers = (payload as { answers?: Record<string, unknown> } | null)?.answers;
  const route = answers?.route as
    | { choice?: unknown; confidence?: unknown; probabilities?: Record<string, unknown> }
    | undefined;
  if (!route || (route.choice !== "retry" && route.choice !== "consult")) {
    return undefined;
  }
  if (typeof route.confidence !== "number") {
    return undefined;
  }
  const probability = route.probabilities?.[route.choice];
  const parsed = jevDecisionSchema.safeParse({
    decision: route.choice,
    confidence: Math.min(Math.max(route.confidence, 0), 1),
    ...(typeof probability === "number" ? { reason: `Laya ${route.choice} p=${probability.toFixed(2)}` } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

export function parseDecision(content: string): JevDecision | undefined {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return undefined;
  }
  try {
    const parsed = jevDecisionSchema.safeParse(JSON.parse(content.slice(start, end + 1)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
