import type { IncomingMessage } from "node:http";
import {
  EvolutionApplicationError,
  EVOLUTION_PROMPT_MATERIAL_MAX_BYTES,
} from "../evolution/application.js";
import {
  EvolutionDomainError,
  EvolutionLifecycleError,
  EvolutionPromotionError,
  EvolutionValidationError,
} from "../evolution/domain.js";
import { EvolutionPersistenceError } from "../evolution/persistence.js";
import {
  evolutionArchiveRequestSchema,
  evolutionConfirmRequestSchema,
  evolutionAutomationStartRequestSchema,
  evolutionDeleteRequestSchema,
  evolutionEmptyRequestSchema,
  evolutionPreviewRequestSchema,
  evolutionPromptProposalRequestSchema,
  evolutionReconcileRequestSchema,
  evolutionReasonRequestSchema,
  evolutionStrategyProposalRequestSchema,
} from "./contracts.js";
import { type EvolutionProjectService, EvolutionServiceError } from "./evolution-service.js";
import { AutomaticEvolutionError } from "./evolution-automation.js";
import { ProjectMutationConflictError } from "./supervisor.js";
import {
  decodePathSegment,
  HttpError,
  invalidRequest,
  maxBodyBytes,
  type ProjectApiRoute,
  type ProjectHttpContext,
  readJson,
  requireEvolutionSession,
  requireIdempotencyKey,
  sendJson,
  singleHeader,
} from "./http-common.js";

const maxEvolutionPromptBodyBytes = 384 * 1024;

export const evolutionRoutes: ProjectApiRoute[] = [
  {
    method: "GET",
    pattern: "/evolution",
    handler: async (context, _request, response, url, _params, _serverOrigin, sessionOperator) => {
      requireEvolutionSession(sessionOperator);
      try {
        sendJson(
          response,
          200,
          await requireEvolutionService(context).snapshot({
            includeArchived: url.searchParams.get("includeArchived") === "true",
          }),
        );
      } catch (error) {
        throw evolutionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/evolution/automation/start",
    handler: async (context, request, response, _url, _params, serverOrigin, sessionOperator) => {
      requireEvolutionMutation(request, serverOrigin, sessionOperator);
      const parsed = evolutionAutomationStartRequestSchema.safeParse(
        await readEvolutionJson(request),
      );
      if (!parsed.success) throw invalidRequest(parsed.error.issues.map((issue) => issue.message));
      try {
        sendJson(
          response,
          202,
          requireEvolutionService(context).startAutomatic(
            parsed.data.maxCycles,
            requireIdempotencyKey(request),
            requireEvolutionSession(sessionOperator),
          ),
        );
      } catch (error) {
        throw evolutionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/evolution/automation/stop",
    handler: async (context, request, response, _url, _params, serverOrigin, sessionOperator) => {
      requireEvolutionMutation(request, serverOrigin, sessionOperator);
      const parsed = evolutionEmptyRequestSchema.safeParse(await readEvolutionJson(request));
      if (!parsed.success) throw invalidRequest(parsed.error.issues.map((issue) => issue.message));
      try {
        sendJson(response, 200, await requireEvolutionService(context).stopAutomatic());
      } catch (error) {
        throw evolutionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/evolution/proposals/strategy",
    handler: async (context, request, response, _url, _params, serverOrigin, sessionOperator) => {
      requireEvolutionMutation(request, serverOrigin, sessionOperator);
      const parsed = evolutionStrategyProposalRequestSchema.safeParse(
        await readEvolutionJson(request),
      );
      if (!parsed.success) throw invalidRequest(parsed.error.issues.map((issue) => issue.message));
      const commandId = requireIdempotencyKey(request);
      try {
        const result = await requireEvolutionService(context).proposeStrategy(commandId, parsed.data);
        sendJson(response, result.deduplicated ? 200 : 201, result);
      } catch (error) {
        throw evolutionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/evolution/proposals/prompt",
    handler: async (context, request, response, _url, _params, serverOrigin, sessionOperator) => {
      requireEvolutionMutation(request, serverOrigin, sessionOperator);
      const parsed = evolutionPromptProposalRequestSchema.safeParse(
        await readEvolutionJson(request, maxEvolutionPromptBodyBytes),
      );
      if (!parsed.success) throw invalidRequest(parsed.error.issues.map((issue) => issue.message));
      const commandId = requireIdempotencyKey(request);
      const content = decodeCanonicalBase64(parsed.data.content);
      if (content.byteLength > EVOLUTION_PROMPT_MATERIAL_MAX_BYTES) {
        throw new HttpError(413, "Prompt content exceeds 256 KiB", "REQUEST_TOO_LARGE");
      }
      try {
        const result = await requireEvolutionService(context).proposePrompt(commandId, {
          role: parsed.data.role,
          content,
        });
        sendJson(response, result.deduplicated ? 200 : 201, result);
      } catch (error) {
        throw evolutionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/evolution/proposals/:proposalId/actions/evaluate",
    handler: async (context, request, response, _url, params, serverOrigin, sessionOperator) => {
      requireEvolutionMutation(request, serverOrigin, sessionOperator);
      const parsed = evolutionEmptyRequestSchema.safeParse(await readEvolutionJson(request));
      if (!parsed.success) throw invalidRequest(parsed.error.issues.map((issue) => issue.message));
      try {
        sendJson(
          response,
          200,
          await requireEvolutionService(context).evaluate(
            decodePathSegment(params.proposalId!),
          ),
        );
      } catch (error) {
        throw evolutionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/evolution/proposals/:proposalId/actions/reject",
    handler: async (context, request, response, _url, params, serverOrigin, sessionOperator) => {
      const operator = requireEvolutionMutation(request, serverOrigin, sessionOperator);
      const parsed = evolutionReasonRequestSchema.safeParse(await readEvolutionJson(request));
      if (!parsed.success) throw invalidRequest(parsed.error.issues.map((issue) => issue.message));
      try {
        sendJson(
          response,
          200,
          await requireEvolutionService(context).reject(
            decodePathSegment(params.proposalId!),
            operator,
            parsed.data.reason,
          ),
        );
      } catch (error) {
        throw evolutionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/evolution/proposals/:proposalId/actions/archive",
    handler: async (context, request, response, _url, params, serverOrigin, sessionOperator) => {
      const operator = requireEvolutionMutation(request, serverOrigin, sessionOperator);
      const parsed = evolutionArchiveRequestSchema.safeParse(await readEvolutionJson(request));
      if (!parsed.success) throw invalidRequest(parsed.error.issues.map((issue) => issue.message));
      try {
        sendJson(
          response,
          200,
          await requireEvolutionService(context).archive(
            decodePathSegment(params.proposalId!),
            operator,
            parsed.data.reason,
          ),
        );
      } catch (error) {
        throw evolutionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/evolution/proposals/:proposalId/actions/unarchive",
    handler: async (context, request, response, _url, params, serverOrigin, sessionOperator) => {
      const operator = requireEvolutionMutation(request, serverOrigin, sessionOperator);
      const parsed = evolutionArchiveRequestSchema.safeParse(await readEvolutionJson(request));
      if (!parsed.success) throw invalidRequest(parsed.error.issues.map((issue) => issue.message));
      try {
        sendJson(
          response,
          200,
          await requireEvolutionService(context).unarchive(
            decodePathSegment(params.proposalId!),
            operator,
            parsed.data.reason,
          ),
        );
      } catch (error) {
        throw evolutionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/evolution/proposals/:proposalId/actions/delete",
    handler: async (context, request, response, _url, params, serverOrigin, sessionOperator) => {
      const operator = requireEvolutionMutation(request, serverOrigin, sessionOperator);
      const parsed = evolutionDeleteRequestSchema.safeParse(await readEvolutionJson(request));
      if (!parsed.success) throw invalidRequest(parsed.error.issues.map((issue) => issue.message));
      try {
        sendJson(
          response,
          200,
          await requireEvolutionService(context).deleteProposal(
            decodePathSegment(params.proposalId!),
            operator,
            parsed.data.reason,
          ),
        );
      } catch (error) {
        throw evolutionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/evolution/proposals/:proposalId/actions/promote/preview",
    handler: async (context, request, response, _url, params, serverOrigin, sessionOperator) => {
      const operator = requireEvolutionMutation(request, serverOrigin, sessionOperator);
      const parsed = evolutionPreviewRequestSchema.safeParse(await readEvolutionJson(request));
      if (!parsed.success) throw invalidRequest(parsed.error.issues.map((issue) => issue.message));
      try {
        sendJson(
          response,
          200,
          await requireEvolutionService(context).previewPromotion(
            decodePathSegment(params.proposalId!),
            operator,
            parsed.data.expectedRevision,
          ),
        );
      } catch (error) {
        throw evolutionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/evolution/proposals/:proposalId/actions/promote/confirm",
    handler: async (context, request, response, _url, params, serverOrigin, sessionOperator) => {
      const operator = requireEvolutionMutation(request, serverOrigin, sessionOperator);
      const parsed = evolutionConfirmRequestSchema.safeParse(await readEvolutionJson(request));
      if (!parsed.success) throw invalidRequest(parsed.error.issues.map((issue) => issue.message));
      try {
        sendJson(response, 200, await requireEvolutionService(context).promote({
          commandId: requireIdempotencyKey(request),
          proposalId: decodePathSegment(params.proposalId!),
          operator,
          reason: parsed.data.reason,
          expectedRevision: parsed.data.expectedRevision,
          token: parsed.data.token,
        }));
      } catch (error) {
        throw evolutionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/evolution/proposals/:proposalId/actions/rollback/preview",
    handler: async (context, request, response, _url, params, serverOrigin, sessionOperator) => {
      const operator = requireEvolutionMutation(request, serverOrigin, sessionOperator);
      const parsed = evolutionPreviewRequestSchema.safeParse(await readEvolutionJson(request));
      if (!parsed.success) throw invalidRequest(parsed.error.issues.map((issue) => issue.message));
      try {
        sendJson(
          response,
          200,
          await requireEvolutionService(context).previewRollback(
            decodePathSegment(params.proposalId!),
            operator,
            parsed.data.expectedRevision,
          ),
        );
      } catch (error) {
        throw evolutionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/evolution/proposals/:proposalId/actions/rollback/confirm",
    handler: async (context, request, response, _url, params, serverOrigin, sessionOperator) => {
      const operator = requireEvolutionMutation(request, serverOrigin, sessionOperator);
      const parsed = evolutionConfirmRequestSchema.safeParse(await readEvolutionJson(request));
      if (!parsed.success) throw invalidRequest(parsed.error.issues.map((issue) => issue.message));
      try {
        sendJson(response, 200, await requireEvolutionService(context).rollback({
          commandId: requireIdempotencyKey(request),
          proposalId: decodePathSegment(params.proposalId!),
          operator,
          reason: parsed.data.reason,
          expectedRevision: parsed.data.expectedRevision,
          token: parsed.data.token,
        }));
      } catch (error) {
        throw evolutionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/evolution/proposals/:proposalId/actions/reconcile",
    handler: async (context, request, response, _url, params, serverOrigin, sessionOperator) => {
      const operator = requireEvolutionMutation(request, serverOrigin, sessionOperator);
      const parsed = evolutionReconcileRequestSchema.safeParse(
        await readEvolutionJson(request),
      );
      if (!parsed.success) throw invalidRequest(parsed.error.issues.map((issue) => issue.message));
      try {
        sendJson(response, 200, await requireEvolutionService(context).adoptLegacyPromotion({
          commandId: requireIdempotencyKey(request),
          proposalId: decodePathSegment(params.proposalId!),
          operator,
          reason: parsed.data.reason,
          expectedRevision: parsed.data.expectedRevision,
        }));
      } catch (error) {
        throw evolutionHttpError(error);
      }
    },
  },
];

function requireEvolutionService(context: ProjectHttpContext): EvolutionProjectService {
  if (!context.evolution) {
    throw new HttpError(503, "Evolution control is unavailable", "EVOLUTION_UNAVAILABLE");
  }
  return context.evolution;
}

function requireEvolutionMutation(
  request: IncomingMessage,
  serverOrigin: string,
  sessionOperator: string | undefined,
): string {
  const operator = requireEvolutionSession(sessionOperator);
  const origin = singleHeader(request.headers.origin);
  if (!origin || origin !== serverOrigin) {
    throw new HttpError(403, "Evolution mutations require the exact local origin", "ORIGIN_DENIED");
  }
  return operator;
}

async function readEvolutionJson(
  request: IncomingMessage,
  limit = maxBodyBytes,
): Promise<unknown> {
  const contentType = singleHeader(request.headers["content-type"]);
  if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json", "UNSUPPORTED_MEDIA_TYPE");
  }
  const contentEncoding = singleHeader(request.headers["content-encoding"]);
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    throw new HttpError(415, "Compressed request bodies are not supported", "UNSUPPORTED_MEDIA_TYPE");
  }
  return await readJson(request, limit);
}

function decodeCanonicalBase64(value: string): Buffer {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new HttpError(422, "Prompt content must be canonical base64", "INVALID_PROMPT_MATERIAL");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new HttpError(422, "Prompt content must be canonical base64", "INVALID_PROMPT_MATERIAL");
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    throw new HttpError(422, "Prompt content must be valid UTF-8", "INVALID_PROMPT_MATERIAL");
  }
  return decoded;
}

function evolutionHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const message = error instanceof Error ? error.message : "Evolution request failed";
  return mappedEvolutionError(error, message);
}

/** Each domain error carries the status and code the client should see. */
function mappedEvolutionError(error: unknown, message: string): HttpError {
  const kind = errorConstructor(error);
  const mapping = kind ? EVOLUTION_ERROR_STATUS.get(kind) : undefined;
  if (!mapping) return fallbackEvolutionError(error, message);
  return mapping(error, message);
}

interface ErrorMapping {
  (error: unknown, message: string): HttpError;
}

type ErrorClass = abstract new (...args: never[]) => Error;

/** The table is keyed by the classes themselves, not by their names. */
const EVOLUTION_ERROR_STATUS = new Map<ErrorClass, ErrorMapping>([
  [ProjectMutationConflictError, (error, message) => new HttpError(409, message, codeOf(error))],
  [
    EvolutionApplicationError,
    statusByCode(
      { PROPOSAL_NOT_FOUND: 404, POLICY_DENIED: 403, MATERIAL_MISSING: 503, RECOVERY_REQUIRED: 503 },
      409,
    ),
  ],
  [
    EvolutionServiceError,
    statusByCode({ PROPOSAL_NOT_FOUND: 404, PROMPT_ROLE_NOT_FOUND: 400, SERVICE_CLOSED: 503 }, 409),
  ],
  [AutomaticEvolutionError, statusByCode({ AUTOMATION_DISABLED: 403 }, 409)],
  [EvolutionLifecycleError, (error, message) => new HttpError(409, message, "INVALID_LIFECYCLE")],
  [EvolutionPromotionError, (error, message) => new HttpError(409, message, "INVALID_LIFECYCLE")],
  [EvolutionValidationError, (error, message) => new HttpError(400, message, "INVALID_REQUEST")],
  [
    EvolutionPersistenceError,
    () => new HttpError(503, "Evolution persistence is unavailable", "EVOLUTION_UNAVAILABLE"),
  ],
  [EvolutionDomainError, (error, message) => new HttpError(400, message, "INVALID_REQUEST")],
]);

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

function statusByCode(statuses: Record<string, number>, fallback: number): ErrorMapping {
  return (error, message) =>
    new HttpError(statuses[codeOf(error) ?? ""] ?? fallback, message, codeOf(error));
}

function errorConstructor(error: unknown): ErrorClass | undefined {
  if (!(error instanceof Error)) return undefined;
  return error.constructor as ErrorClass;
}

function fallbackEvolutionError(error: unknown, message: string): HttpError {
  void error;
  void message;
  return new HttpError(500, "Evolution request failed", "INTERNAL_ERROR");
}
