import { classifyProviderFailure, ProviderFailureError } from "../providers/failure.js";
import type { AgentSession, TurnInput, TurnResult } from "./types.js";

/**
 * Runs a turn and converts a failed turn into the provider-failure error the
 * profile fallback chain already understands. Interrupted turns are returned
 * to the caller, which decides whether that means cancel or retry.
 */
export async function runTurnOrThrow(
  session: AgentSession,
  input: TurnInput,
  context: { profile?: string; adapter?: string; model?: string } = {},
): Promise<TurnResult> {
  const result = await session.runTurn(input);
  if (result.status === "failed") {
    const message = result.error ?? "agent turn failed";
    throw new ProviderFailureError(
      message,
      classifyProviderFailure({ message, stdout: result.text }),
      context.profile,
      context.adapter,
      context.model,
    );
  }
  return result;
}
