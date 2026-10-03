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
    private readonly config: Pick<JevConfig, "baseUrl" | "model" | "timeoutMs">,
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
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetchImpl(this.endpoint(), {
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

  private endpoint(): URL {
    const base = this.config.baseUrl.endsWith("/") ? this.config.baseUrl : `${this.config.baseUrl}/`;
    return new URL("chat/completions", base);
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
