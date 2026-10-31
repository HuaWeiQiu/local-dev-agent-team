import { z } from "zod";

export const jevDecisionSchema = z.object({
  decision: z.enum(["retry", "consult"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500).optional(),
});

export type JevDecision = z.infer<typeof jevDecisionSchema>;

export interface JevDecisionInput {
  taskId: string;
  taskTitle: string;
  attempt: number;
  maxAttempts: number;
  repeated: boolean;
  failureSummary: string;
}

/** A cheap, fast routing model. It can only advise; callers must tolerate `undefined`. */
export interface ForkAdvisor {
  decide(input: JevDecisionInput, signal?: AbortSignal): Promise<JevDecision | undefined>;
}

export interface ConsultationResolution {
  consult: boolean;
  source: "jev" | "deterministic";
  reason: string;
}

/**
 * Combines the deterministic repeated-failure verdict with the fork model.
 * Jev may only bring the architect forward, and only when it clears the
 * confidence threshold. It can never skip a consultation the deterministic
 * rule already requires: a fast classifier saying "retry" is not evidence that
 * a repeated failure is safe to retry, and an extra consultation is cheap.
 */
export function resolveConsultation(input: {
  repeated: boolean;
  jev: JevDecision | undefined;
  minConfidence: number;
}): ConsultationResolution {
  const { repeated, jev, minConfidence } = input;
  if (!jev) {
    return { consult: repeated, source: "deterministic", reason: "Jev unavailable" };
  }
  if (jev.confidence < minConfidence) {
    return {
      consult: repeated,
      source: "deterministic",
      reason: `Jev confidence ${jev.confidence.toFixed(2)} below ${minConfidence.toFixed(2)}`,
    };
  }
  if (jev.decision === "consult") {
    return { consult: true, source: "jev", reason: jev.reason ?? "Jev chose consult" };
  }
  return {
    consult: repeated,
    source: "deterministic",
    reason: repeated
      ? "Jev chose retry, but a repeated failure always consults the architect"
      : (jev.reason ?? "Jev chose retry"),
  };
}
