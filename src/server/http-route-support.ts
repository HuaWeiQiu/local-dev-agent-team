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

interface HttpErrorRule {
  matches(error: unknown, message: string): boolean;
  map(error: unknown, message: string): HttpError;
}

/** Intervention codes map onto the closest HTTP status; anything else is a bad request. */
function interventionStatus(code: string): number {
  if (code === "not-found") return 404;
  if (code === "unsupported") return 409;
  return 400;
}

function interventionCode(code: string): string {
  return `AGENT_${code.toUpperCase().replace("-", "_")}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ordered rules, most specific first: an error is answered by the first rule
 * that owns it, and anything no rule claims is an internal failure.
 */
const httpErrorRules: HttpErrorRule[] = [
  {
    // GitHub publication failures carry actionable prompts that the UI must
    // surface verbatim (not logged in, missing git identity, token scopes...).
    matches: (error) => error instanceof GithubActionError,
    map: (error) => new HttpError(422, messageOf(error), (error as GithubActionError).code),
  },
  {
    matches: (error) => error instanceof ProjectMutationConflictError,
    map: (error, message) =>
      new HttpError(409, message, (error as ProjectMutationConflictError).code),
  },
  {
    matches: (error) => error instanceof InterventionError,
    map: (error, message) => {
      const code = (error as InterventionError).code;
      return new HttpError(interventionStatus(code), message, interventionCode(code));
    },
  },
  {
    matches: (error, message) =>
      error instanceof RunNotFoundError || runNotFoundMessage.test(message),
    map: (_error, message) => new HttpError(404, message, "RUN_NOT_FOUND"),
  },
  {
    matches: (_error, message) => runStateConflictMessage.test(message),
    map: (_error, message) => new HttpError(409, message, "RUN_STATE_CONFLICT"),
  },
  {
    matches: (_error, message) => runParameterMessage.test(message),
    map: (_error, message) => new HttpError(400, message, "INVALID_REQUEST"),
  },
];

export function runActionHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const message = messageOf(error);
  const rule = httpErrorRules.find((candidate) => candidate.matches(error, message));
  if (rule) return rule.map(error, message);
  // Unexpected failure: log the detail server-side, return a generic body.
  console.error(`[agent-team] run action failed: ${message}`);
  return new HttpError(500, "Run action failed", "INTERNAL_ERROR");
}
