/**
 * The GitHub Source: webhook payloads in, Triggers out.
 *
 * A Source keeps its read position and drops what it must not act on before the
 * domain ever sees it: its own messages, events from another repository, and
 * event kinds it does not listen to. What survives becomes one immutable Trigger
 * per external event, with a stable id so a webhook delivered twice yields one.
 *
 * Which id is stable depends on the event kind, and that is the whole difficulty:
 *
 * | Event | Idempotence key | Why |
 * | --- | --- | --- |
 * | `issue_comment` | `comment.id` | assigned once per comment, never reused |
 * | `pull_request_review_comment` | `comment.id` | same |
 * | `check_run` | `check_run.id:conclusion:completed_at` | a run reports several conclusions; the tuple names one |
 * | `pull_request` | `number:action` | one close per pull request; a reopen is another action |
 *
 * A payload missing its key yields no Trigger rather than a fresh one: a wrong id
 * would start the same work twice, which is worse than acting on nothing.
 */

import type { ActorRef, ThreadRef, TriggerDraft, TriggerKind } from "./types.js";

export interface GithubContext {
  /** Identifies the source instance: `owner/repo`. */
  instanceId: string;
  /** The identities this agent posts under; their events are dropped. */
  selfLogins: readonly string[];
  /** Event names the Source listens to; empty means the default set. */
  listened?: readonly string[];
}

/** An event that produced no Trigger, with the reason kept for the audit trail. */
export interface DroppedEvent {
  event: string;
  code: "not-listened" | "other-repository" | "own-message" | "unsupported" | "incomplete";
}

export interface GithubIntake {
  drafts: TriggerDraft[];
  dropped: DroppedEvent[];
}

const DEFAULT_LISTENED = [
  "issue_comment",
  "pull_request_review_comment",
  "pull_request",
  "check_run",
];

type Json = Record<string, unknown>;

export function githubIntake(event: string, payload: unknown, context: GithubContext): GithubIntake {
  const body = asObject(payload);
  if (!body) return { drafts: [], dropped: [{ event, code: "incomplete" }] };
  const builder = listenedBuilder(event, context);
  if (!builder) return { drafts: [], dropped: [{ event, code: "not-listened" }] };
  if (isOtherRepository(body, context)) {
    return { drafts: [], dropped: [{ event, code: "other-repository" }] };
  }
  const draft = builder(body, context);
  if (!draft) return { drafts: [], dropped: [{ event, code: "incomplete" }] };
  return { drafts: [draft], dropped: [] };
}

type Builder = (body: Json, context: GithubContext) => TriggerDraft | undefined;

const BUILDERS: Record<string, Builder> = {
  issue_comment: (body, context) => commentDraft(body, context, "comment"),
  pull_request_review_comment: (body, context) =>
    commentDraft(body, context, "review", body.pull_request),
  pull_request: (body, context) => closeDraft(body, context),
  check_run: (body, context) => checkDraft(body, context),
};

/** The builder for an event this Source listens to, if it has one. */
function listenedBuilder(event: string, context: GithubContext): Builder | undefined {
  const listened = context.listened?.length ? context.listened : DEFAULT_LISTENED;
  return listened.includes(event) ? BUILDERS[event] : undefined;
}

function isOtherRepository(body: Json, context: GithubContext): boolean {
  const repository = asObject(body.repository)?.full_name;
  return typeof repository === "string" && repository !== context.instanceId;
}

/** A comment on an issue or a pull request; the issue carries the thread. */
function commentDraft(
  body: Json,
  context: GithubContext,
  kind: TriggerKind,
  pull: unknown = asObject(body.issue)?.pull_request,
): TriggerDraft | undefined {
  const comment = asObject(body.comment);
  const number = issueNumber(body);
  if (!comment || number === undefined) return undefined;
  const actor = actorOf(comment.user);
  if (!actor || isSelf(actor, context)) return undefined;
  const externalId = commentId(comment.id);
  if (!externalId) return undefined;
  return {
    sourceKind: "github",
    sourceInstanceId: context.instanceId,
    externalId,
    kind,
    threads: [threadRef(context.instanceId, pull ? "pull" : "issue", number)],
    actor,
    at: timestamp(comment.created_at),
  };
}

/** A pull request that closed or merged: the thread is the pull request. */
function closeDraft(body: Json, context: GithubContext): TriggerDraft | undefined {
  const action = body.action;
  const pull = asObject(body.pull_request);
  if (action !== "closed" || !pull) return undefined;
  const number = numberField(pull.number);
  const actor = actorOf(pull.user);
  if (number === undefined || !actor || isSelf(actor, context)) return undefined;
  return {
    sourceKind: "github",
    sourceInstanceId: context.instanceId,
    externalId: `${number}:closed`,
    kind: "close",
    threads: [threadRef(context.instanceId, "pull", number)],
    actor,
    at: timestamp(pull.closed_at ?? pull.updated_at),
  };
}

/** A completed check run on one pull request. */
function checkDraft(body: Json, context: GithubContext): TriggerDraft | undefined {
  const run = asObject(body.check_run);
  if (!run || run.status !== "completed") return undefined;
  const pull = firstPullNumber(run.pull_requests);
  const id = numberField(run.id);
  if (pull === undefined || id === undefined) return undefined;
  const conclusion = conclusionOf(run);
  return {
    sourceKind: "github",
    sourceInstanceId: context.instanceId,
    externalId: `check_run:${id}:${conclusion}:${String(run.completed_at ?? "")}`,
    kind: "ci-change",
    threads: [threadRef(context.instanceId, "pull", pull)],
    actor: { sourceKind: "github", id: "ci" },
    at: timestamp(run.completed_at),
  };
}

function conclusionOf(run: Json): string {
  return typeof run.conclusion === "string" ? run.conclusion : "unknown";
}

function issueNumber(body: Json): number | undefined {
  const issue = asObject(body.issue);
  const fromIssue = numberField(issue?.number);
  if (fromIssue !== undefined) return fromIssue;
  return numberField(asObject(body.pull_request)?.number);
}

function firstPullNumber(value: unknown): number | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return numberField(asObject(value[0])?.number);
}

function threadRef(
  instanceId: string,
  kind: "pull" | "issue",
  number: number,
): ThreadRef {
  return { sourceKind: "github", sourceInstanceId: instanceId, threadId: `${kind}/${number}` };
}

function actorOf(value: unknown): ActorRef | undefined {
  const user = asObject(value);
  const login = typeof user?.login === "string" ? user.login : undefined;
  return login ? { sourceKind: "github", id: login } : undefined;
}

/** The bot's own comments never become work. */
function isSelf(actor: ActorRef, context: GithubContext): boolean {
  return context.selfLogins.includes(actor.id);
}

/** A comment id, or a refusal: a guessed id would duplicate work. */
function commentId(value: unknown): string | undefined {
  const id = numberField(value);
  return id === undefined ? undefined : `comment:${id}`;
}

function numberField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function timestamp(value: unknown): string {
  return typeof value === "string" ? value : new Date(0).toISOString();
}

function asObject(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}
