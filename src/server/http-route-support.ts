import type { RunEvent } from "../events/types.js";
import { InterventionError } from "../interventions/registry.js";
import { GithubActionError } from "../github/errors.js";
import { ProjectMutationConflictError, RunNotFoundError, type RunSupervisor } from "./supervisor.js";
import { HttpError } from "./http-common.js";

export function listRunEvents(supervisor: RunSupervisor, runId: string): RunEvent[] {
  const collected: RunEvent[] = [];
  let cursor = 0;
  while (true) {
    const page = supervisor.events.listAfter(cursor, runId, 10_000);
    collected.push(...page);
    if (page.length < 10_000) return collected;
    cursor = page.at(-1)!.sequence;
  }
}

export const runNotFoundMessage = /was not found/;

export const runStateConflictMessage =
  /from status '|is already active|is still active|cannot be deleted|active child run|referenced as a parent|changed after preview|already has a response|is not the latest request|expired at |missing or expired|already used for another request|cannot be retried directly|no recoverable task-boundary checkpoint|requires approval before worker recovery|can only be edited while|cannot be edited|Only an approved plan gate/;

export const runParameterMessage =
  /^Unknown (?:strategy|profile|role|fallback profile) |^Profile '.+' is not allowed|must be an integer|^Invalid run ID|^Edited plan is invalid|^Task '.+' uses profile|^Duplicate task id|depends on unknown task|dependency cycle|cannot depend on itself/;

export function runActionHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const message = error instanceof Error ? error.message : String(error);
  // GitHub publication failures carry actionable prompts that the UI must
  // surface verbatim (not logged in, missing git identity, token scopes...).
  if (error instanceof GithubActionError) {
    return new HttpError(422, error.message, error.code);
  }
  if (error instanceof ProjectMutationConflictError) {
    return new HttpError(409, message, error.code);
  }
  if (error instanceof InterventionError) {
    const status = error.code === "not-found" ? 404 : error.code === "unsupported" ? 409 : 400;
    return new HttpError(status, message, `AGENT_${error.code.toUpperCase().replace("-", "_")}`);
  }
  if (error instanceof RunNotFoundError || runNotFoundMessage.test(message)) {
    return new HttpError(404, message, "RUN_NOT_FOUND");
  }
  if (runStateConflictMessage.test(message)) {
    return new HttpError(409, message, "RUN_STATE_CONFLICT");
  }
  if (runParameterMessage.test(message)) {
    return new HttpError(400, message, "INVALID_REQUEST");
  }
  // Unexpected failure: log the detail server-side, return a generic body.
  console.error(`[agent-team] run action failed: ${message}`);
  return new HttpError(500, "Run action failed", "INTERNAL_ERROR");
}
