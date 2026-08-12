import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LoadedConfig } from "../config/load.js";
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
import type { RunEvent } from "../events/types.js";
import { buildOtlpTraceExport } from "../observability/otlp.js";
import { buildInteropManifest } from "../interop/manifest.js";
import { resolveStrategy } from "../strategies/resolve.js";
import {
  legacyApprovalTimeoutSeconds,
  legacyExecutionTimeoutSeconds,
  legacyMaxAgentInvocations,
  legacyMaxArtifactBytes,
  legacyMaxProcessOutputBytes,
} from "../strategies/defaults.js";
import {
  StrategyBlueprintCatalog,
  StrategyBlueprintConflictError,
  StrategyBlueprintNotFoundError,
  type CheckedStrategyBlueprint,
} from "../strategies/catalog.js";
import {
  approvalResponseRequestSchema,
  cleanupPreviewRequestSchema,
  cleanupRunRequestSchema,
  evolutionConfirmRequestSchema,
  evolutionAutomationStartRequestSchema,
  evolutionEmptyRequestSchema,
  evolutionPreviewRequestSchema,
  evolutionPromptProposalRequestSchema,
  evolutionReconcileRequestSchema,
  evolutionReasonRequestSchema,
  evolutionStrategyProposalRequestSchema,
  desktopSettingsUpdateSchema,
  experienceReasonRequestSchema,
  resumeRunRequestSchema,
  startRunRequestSchema,
  strategyBlueprintPreflightRequestSchema,
  strategyBlueprintRequestSchema,
} from "./contracts.js";
import { getInventory } from "../desktop/settings.js";
import {
  loadDesktopSettings,
  mergeRoleDefaults,
  saveDesktopSettings,
  suggestDefaultsFromInventory,
} from "../desktop/settings.js";
import { ExperienceService } from "../experience/service.js";
import { EvolutionProjectService, EvolutionServiceError } from "./evolution-service.js";
import { AutomaticEvolutionError } from "./evolution-automation.js";
import {
  ProjectMutationConflictError,
  RunNotFoundError,
  type RunSupervisor,
} from "./supervisor.js";

const maxBodyBytes = 64 * 1024;
const maxEvolutionPromptBodyBytes = 384 * 1024;
const desktopSessionPath = "/__agent_team/session";
const desktopSessionTokenPattern = /^[a-f0-9]{64}$/;

interface HttpServerOptions {
  host: string;
  port: number;
  staticDirectory?: string;
  sessionToken?: string;
}

export interface ListeningControlServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export interface ProjectHttpContext {
  id: string;
  loaded: LoadedConfig;
  supervisor: RunSupervisor;
  strategies?: StrategyBlueprintCatalog;
  evolution?: EvolutionProjectService;
}

export async function listenControlServer(
  loaded: LoadedConfig,
  supervisor: RunSupervisor,
  options: {
    host: string;
    port: number;
    staticDirectory?: string;
    strategyCatalog?: StrategyBlueprintCatalog;
    evolutionService?: EvolutionProjectService;
    sessionToken?: string;
  },
): Promise<ListeningControlServer> {
  const context: ProjectHttpContext = {
    id: "default",
    loaded,
    supervisor,
    ...(options.strategyCatalog ? { strategies: options.strategyCatalog } : {}),
    ...(options.evolutionService ? { evolution: options.evolutionService } : {}),
  };
  return await listenHttpServer(
    (request, response, staticDirectory, serverOrigin, sessionOperator) =>
      handleSingleProjectRequest(
        context,
        request,
        response,
        staticDirectory,
        serverOrigin,
        sessionOperator,
      ),
    options,
  );
}

export async function listenWorkspaceServer(
  projects: ProjectHttpContext[],
  options: HttpServerOptions,
): Promise<ListeningControlServer> {
  if (projects.length === 0) {
    throw new Error("A workspace control server requires at least one project");
  }
  const byId = new Map(projects.map((project) => [project.id, project]));
  if (byId.size !== projects.length) {
    throw new Error("Workspace project IDs must be unique");
  }
  return await listenHttpServer(
    (request, response, staticDirectory, serverOrigin, sessionOperator) =>
      handleWorkspaceRequest(
        projects,
        byId,
        request,
        response,
        staticDirectory,
        serverOrigin,
        sessionOperator,
      ),
    options,
  );
}

async function listenHttpServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    staticDirectory: string,
    serverOrigin: string,
    sessionOperator: string | undefined,
  ) => Promise<void>,
  options: HttpServerOptions,
): Promise<ListeningControlServer> {
  assertLoopbackHost(options.host);
  if (options.sessionToken && !desktopSessionTokenPattern.test(options.sessionToken)) {
    throw new Error("Desktop session token must contain 64 lowercase hexadecimal characters");
  }
  const staticDirectory = options.staticDirectory ?? bundledWebDirectory;
  let serverOrigin = "";
  const sessionOperator = options.sessionToken
    ? `local-session:${createHash("sha256").update(options.sessionToken).digest("hex").slice(0, 16)}`
    : undefined;
  const server = createServer((request, response) => {
    setSecurityHeaders(response);
    void Promise.resolve()
      .then(() => handleDesktopSession(request, response, options.sessionToken))
      .then(async (handled) => {
        if (!handled) {
          await handler(request, response, staticDirectory, serverOrigin, sessionOperator);
        }
      })
      .catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined);
          return;
        }
        const handled = error instanceof HttpError;
        sendJson(response, handled ? error.status : 500, {
          error: handled ? error.message : "Internal server error",
          ...(handled
            ? error.code
              ? { code: error.code }
              : {}
            : { code: "INTERNAL_ERROR" }),
        });
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const url = `http://${formatHost(options.host)}:${address.port}`;
  serverOrigin = url;
  let closePromise: Promise<void> | undefined;
  return {
    server,
    url,
    close: () => {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      return closePromise;
    },
  };
}

function handleDesktopSession(
  request: IncomingMessage,
  response: ServerResponse,
  sessionToken: string | undefined,
): boolean {
  if (!sessionToken) return false;
  const cookieName = desktopSessionCookieName(sessionToken);
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname === desktopSessionPath) {
    if (
      request.method !== "GET" ||
      !secureEqual(url.searchParams.get("token"), sessionToken)
    ) {
      throw new HttpError(401, "Desktop session could not be established");
    }
    response.writeHead(303, {
      Location: "/?desktop-runtime=1",
      "Set-Cookie": `${cookieName}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`,
      "Cache-Control": "no-store",
    });
    response.end();
    return true;
  }
  if (isApiPath(url.pathname) && !hasDesktopSession(request, cookieName, sessionToken)) {
    throw new HttpError(401, "Desktop session is required");
  }
  return false;
}

function hasDesktopSession(
  request: IncomingMessage,
  cookieName: string,
  sessionToken: string,
): boolean {
  const cookieHeader = singleHeader(request.headers.cookie);
  if (!cookieHeader) return false;
  const value = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  return secureEqual(value, sessionToken);
}

function desktopSessionCookieName(sessionToken: string): string {
  const suffix = createHash("sha256").update(sessionToken).digest("hex").slice(0, 16);
  return `agent_team_session_${suffix}`;
}

function secureEqual(candidate: string | null | undefined, expected: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function handleSingleProjectRequest(
  context: ProjectHttpContext,
  request: IncomingMessage,
  response: ServerResponse,
  staticDirectory: string,
  serverOrigin: string,
  sessionOperator: string | undefined,
): Promise<void> {
  setSecurityHeaders(response);
  validateOrigin(request, serverOrigin);
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/workspace") {
    sendJson(response, 200, workspaceProjection("single", [context]));
    return;
  }
  if (await dispatchDesktopApi(request, response, url, method, serverOrigin, sessionOperator)) {
    return;
  }
  if (
    await dispatchProjectApi(
      context,
      request,
      response,
      url,
      "/api",
      serverOrigin,
      sessionOperator,
    )
  ) {
    return;
  }
  if ((method === "GET" || method === "HEAD") && !isApiPath(url.pathname)) {
    if (await serveWebAsset(response, url.pathname, staticDirectory, method === "HEAD")) {
      return;
    }
  }
  throw new HttpError(404, "Route not found");
}

async function handleWorkspaceRequest(
  projects: ProjectHttpContext[],
  byId: Map<string, ProjectHttpContext>,
  request: IncomingMessage,
  response: ServerResponse,
  staticDirectory: string,
  serverOrigin: string,
  sessionOperator: string | undefined,
): Promise<void> {
  setSecurityHeaders(response);
  validateOrigin(request, serverOrigin);
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const method = request.method ?? "GET";

  if (method === "GET" && (url.pathname === "/api/workspace" || url.pathname === "/api/projects")) {
    sendJson(response, 200, workspaceProjection("workspace", projects));
    return;
  }
  if (method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      status: "ok",
      mode: "workspace",
      projectCount: projects.length,
    });
    return;
  }
  if (await dispatchDesktopApi(request, response, url, method, serverOrigin, sessionOperator)) {
    return;
  }
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/|$)/);
  if (match?.[1]) {
    const projectId = decodePathSegment(match[1]);
    const context = byId.get(projectId);
    if (!context) {
      throw new HttpError(404, "Project not found");
    }
    const apiRoot = `/api/projects/${match[1]}`;
    if (
      await dispatchProjectApi(
        context,
        request,
        response,
        url,
        apiRoot,
        serverOrigin,
        sessionOperator,
      )
    ) {
      return;
    }
  }
  if ((method === "GET" || method === "HEAD") && !isApiPath(url.pathname)) {
    if (await serveWebAsset(response, url.pathname, staticDirectory, method === "HEAD")) {
      return;
    }
  }
  throw new HttpError(404, "Route not found");
}

type ProjectApiHandler = (
  context: ProjectHttpContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  params: Record<string, string>,
  serverOrigin: string,
  sessionOperator: string | undefined,
) => Promise<void> | void;

interface ProjectApiRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  pattern: string;
  handler: ProjectApiHandler;
}

const projectApiRoutes: ProjectApiRoute[] = [
  {
    method: "GET",
    pattern: "/health",
    handler: (context, _request, response) => {
      sendJson(response, 200, {
        status: "ok",
        project: context.loaded.config.project.name,
        projectId: context.id,
        supervisorId: context.supervisor.id,
      });
    },
  },
  {
    method: "GET",
    pattern: "/config",
    handler: (context, _request, response) => {
      sendJson(response, 200, buildPublicConfig(context.loaded, context.strategies));
    },
  },
  {
    method: "GET",
    pattern: "/evolution",
    handler: async (context, _request, response, _url, _params, _serverOrigin, sessionOperator) => {
      requireEvolutionSession(sessionOperator);
      try {
        sendJson(response, 200, await requireEvolutionService(context).snapshot());
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
  {
    method: "GET",
    pattern: "/experience",
    handler: async (context, _request, response, url) => {
      const status = url.searchParams.get("status") ?? undefined;
      if (
        status &&
        !["candidate", "verified", "rejected", "retired"].includes(status)
      ) {
        throw new HttpError(400, "Invalid experience status filter");
      }
      const service = ExperienceService.forLoaded(context.loaded);
      sendJson(
        response,
        200,
        await service.snapshot(
          status as "candidate" | "verified" | "rejected" | "retired" | undefined,
        ),
      );
    },
  },
  {
    method: "GET",
    pattern: "/experience/retrieve",
    handler: async (context, _request, response, url) => {
      const service = ExperienceService.forLoaded(context.loaded);
      const query = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
      // preview=1 keeps the lookup read-only: no hitCount/audit mutation.
      const preview = url.searchParams.get("preview") === "1";
      const bundle = await service.retrieveForPlanning(
        query || context.loaded.config.project.name,
        { preview },
      );
      sendJson(response, 200, bundle ?? { note: "无已验证经验", items: [] });
    },
  },
  {
    method: "POST",
    pattern: "/experience/:experienceId/actions/promote",
    handler: async (context, request, response, _url, params, _serverOrigin, sessionOperator) => {
      const parsed = experienceReasonRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      const actor =
        parsed.data.actor ??
        sessionOperator ??
        singleHeader(request.headers["x-agent-team-operator"]) ??
        "operator";
      try {
        const service = ExperienceService.forLoaded(context.loaded);
        const entry = await service.promote(
          decodePathSegment(params.experienceId!),
          actor,
          parsed.data.reason,
          {
            ...(parsed.data.suiteDigest ? { suiteDigest: parsed.data.suiteDigest } : {}),
            ...(parsed.data.forceWithoutSuite ? { forceWithoutSuite: true } : {}),
          },
        );
        sendJson(response, 200, entry);
      } catch (error) {
        throw experienceHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/experience/:experienceId/actions/reject",
    handler: async (context, request, response, _url, params, _serverOrigin, sessionOperator) => {
      const parsed = experienceReasonRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      const actor =
        parsed.data.actor ??
        sessionOperator ??
        singleHeader(request.headers["x-agent-team-operator"]) ??
        "operator";
      try {
        const service = ExperienceService.forLoaded(context.loaded);
        const entry = await service.reject(
          decodePathSegment(params.experienceId!),
          actor,
          parsed.data.reason,
        );
        sendJson(response, 200, entry);
      } catch (error) {
        throw experienceHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/experience/:experienceId/actions/retire",
    handler: async (context, request, response, _url, params, _serverOrigin, sessionOperator) => {
      const parsed = experienceReasonRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      const actor =
        parsed.data.actor ??
        sessionOperator ??
        singleHeader(request.headers["x-agent-team-operator"]) ??
        "operator";
      try {
        const service = ExperienceService.forLoaded(context.loaded);
        const entry = await service.retire(
          decodePathSegment(params.experienceId!),
          actor,
          parsed.data.reason,
        );
        sendJson(response, 200, entry);
      } catch (error) {
        throw experienceHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/experience/:experienceId/actions/share",
    handler: async (context, request, response, _url, params, _serverOrigin, sessionOperator) => {
      const parsed = experienceReasonRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      const actor =
        parsed.data.actor ??
        sessionOperator ??
        singleHeader(request.headers["x-agent-team-operator"]) ??
        "operator";
      try {
        const service = ExperienceService.forLoaded(context.loaded);
        const entry = await service.share(
          decodePathSegment(params.experienceId!),
          actor,
          parsed.data.reason,
        );
        sendJson(response, 200, entry);
      } catch (error) {
        throw experienceHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/strategies/preflight",
    handler: async (context, request, response) => {
      const parsed = strategyBlueprintPreflightRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      try {
        const checked = requireStrategyCatalog(context).preflight(
          parsed.data.name,
          parsed.data.definition,
        );
        sendJson(response, 200, blueprintProjection(checked, "custom"));
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw strategyHttpError(error);
      }
    },
  },
  {
    method: "PUT",
    pattern: "/strategies/:name",
    handler: async (context, request, response, _url, params) => {
      const name = decodePathSegment(params.name!);
      const catalog = requireStrategyCatalog(context);
      try {
        const parsed = strategyBlueprintRequestSchema.safeParse(await readJson(request));
        if (!parsed.success) {
          throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
        }
        const save = async () => await catalog.save(name, parsed.data.definition);
        const checked = context.evolution
          ? await context.evolution.withTargetMutation(save)
          : await save();
        sendJson(response, 200, blueprintProjection(checked, "custom"));
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw strategyHttpError(error);
      }
    },
  },
  {
    method: "DELETE",
    pattern: "/strategies/:name",
    handler: async (context, _request, response, _url, params) => {
      const name = decodePathSegment(params.name!);
      const catalog = requireStrategyCatalog(context);
      try {
        const remove = async () => await catalog.delete(name);
        if (context.evolution) {
          await context.evolution.withTargetMutation(remove);
        } else {
          await remove();
        }
        sendJson(response, 200, { name, deleted: true });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw strategyHttpError(error);
      }
    },
  },
  {
    method: "GET",
    pattern: "/interop",
    handler: (context, _request, response) => {
      sendJson(response, 200, buildInteropManifest(context.loaded.config));
    },
  },
  {
    method: "GET",
    pattern: "/runs",
    handler: async (context, _request, response) => {
      sendJson(response, 200, { runs: await context.supervisor.list() });
    },
  },
  {
    method: "POST",
    pattern: "/runs",
    handler: async (context, request, response) => {
      const parsed = startRunRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      const idempotency = optionalIdempotencyKey(request);
      try {
        const result = context.supervisor.start(parsed.data, idempotency);
        sendJson(response, result.deduplicated ? 200 : 202, result);
      } catch (error) {
        throw runActionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/runs/cleanup/preview",
    handler: async (context, request, response) => {
      const parsed = cleanupPreviewRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      sendJson(response, 200, await context.supervisor.previewCleanup(parsed.data.olderThanDays));
    },
  },
  {
    method: "POST",
    pattern: "/runs/cleanup",
    handler: async (context, request, response) => {
      const parsed = cleanupRunRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      try {
        sendJson(response, 200, await context.supervisor.cleanup(parsed.data.token));
      } catch (error) {
        throw runActionHttpError(error);
      }
    },
  },
  {
    method: "GET",
    pattern: "/events",
    handler: (context, request, response, url) => {
      streamEvents(request, response, context.supervisor, url.searchParams.get("runId") ?? undefined);
    },
  },
  {
    method: "GET",
    pattern: "/usage",
    handler: async (context, _request, response) => {
      sendJson(response, 200, await context.supervisor.usageReport());
    },
  },
  {
    method: "GET",
    pattern: "/runs/:runId/export",
    handler: async (context, _request, response, _url, params) => {
      const runId = decodePathSegment(params.runId!);
      if (!(await context.supervisor.get(runId))) {
        throw new HttpError(404, "Run not found");
      }
      const lines = listRunEvents(context.supervisor, runId).map((event) => JSON.stringify(event));
      const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
      response.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="${runId}.ndjson"`,
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
      });
      response.end(body);
    },
  },
  {
    method: "GET",
    pattern: "/runs/:runId/telemetry",
    handler: async (context, _request, response, _url, params) => {
      const runId = decodePathSegment(params.runId!);
      if (!(await context.supervisor.get(runId))) {
        throw new HttpError(404, "Run not found");
      }
      sendJson(
        response,
        200,
        buildOtlpTraceExport(
          listRunEvents(context.supervisor, runId),
          context.loaded.config.project.name,
        ),
      );
    },
  },
  {
    method: "GET",
    pattern: "/runs/:runId/evidence/file",
    handler: async (context, _request, response, url, params) => {
      const relativePath = url.searchParams.get("path");
      if (!relativePath) throw new HttpError(400, "Artifact path is required");
      const runId = decodePathSegment(params.runId!);
      try {
        sendJson(response, 200, {
          file: await context.supervisor.evidenceFile(runId, relativePath),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new HttpError(message.includes("was not found") ? 404 : 400, message);
      }
    },
  },
  {
    method: "GET",
    pattern: "/runs/:runId/evidence",
    handler: async (context, _request, response, _url, params) => {
      const evidence = await context.supervisor.evidence(decodePathSegment(params.runId!));
      if (!evidence) throw new HttpError(404, "Run not found");
      sendJson(response, 200, { evidence });
    },
  },
  {
    method: "GET",
    pattern: "/runs/:runId",
    handler: async (context, _request, response, _url, params) => {
      const run = await context.supervisor.get(decodePathSegment(params.runId!));
      if (!run) {
        throw new HttpError(404, "Run not found");
      }
      sendJson(response, 200, { run });
    },
  },
  {
    method: "POST",
    pattern: "/runs/:runId/actions/cancel",
    handler: async (context, _request, response, _url, params) => {
      const runId = decodePathSegment(params.runId!);
      try {
        if (!(await context.supervisor.cancel(runId))) {
          throw new HttpError(409, "Run is not active in this control service");
        }
        sendJson(response, 202, { runId, status: "cancel-requested" });
      } catch (error) {
        throw runActionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/runs/:runId/actions/retry",
    handler: async (context, request, response, _url, params) => {
      const runId = decodePathSegment(params.runId!);
      const idempotency = optionalIdempotencyKey(request);
      try {
        const result = await context.supervisor.retry(runId, idempotency);
        sendJson(response, result.deduplicated ? 200 : 202, result);
      } catch (error) {
        throw runActionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/runs/:runId/actions/delete",
    handler: async (context, _request, response, _url, params) => {
      try {
        sendJson(
          response,
          200,
          await context.supervisor.deleteRun(decodePathSegment(params.runId!)),
        );
      } catch (error) {
        throw runActionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/runs/:runId/actions/respond-approval",
    handler: async (context, request, response, _url, params) => {
      const parsed = approvalResponseRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      try {
        const result = await context.supervisor.respondApproval(
          decodePathSegment(params.runId!),
          parsed.data,
        );
        sendJson(response, result.status === "resuming" ? 202 : 200, result);
      } catch (error) {
        throw runActionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/runs/:runId/actions/resume",
    handler: async (context, request, response, _url, params) => {
      const parsed = resumeRunRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      try {
        const result = await context.supervisor.resume(decodePathSegment(params.runId!), parsed.data);
        sendJson(response, 202, result);
      } catch (error) {
        throw runActionHttpError(error);
      }
    },
  },
];

async function dispatchProjectApi(
  context: ProjectHttpContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  apiRoot: string,
  serverOrigin: string,
  sessionOperator: string | undefined,
): Promise<boolean> {
  if (url.pathname !== apiRoot && !url.pathname.startsWith(`${apiRoot}/`)) {
    return false;
  }
  const localPath = url.pathname.slice(apiRoot.length) || "/";
  const method = request.method ?? "GET";
  for (const route of projectApiRoutes) {
    if (route.method !== method) continue;
    const params = matchRoutePattern(route.pattern, localPath);
    if (!params) continue;
    await route.handler(
      context,
      request,
      response,
      url,
      params,
      serverOrigin,
      sessionOperator,
    );
    return true;
  }
  return false;
}

function matchRoutePattern(
  pattern: string,
  localPath: string,
): Record<string, string> | undefined {
  const patternSegments = pattern.split("/");
  const pathSegments = localPath.split("/");
  if (patternSegments.length !== pathSegments.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index]!;
    const actual = pathSegments[index]!;
    if (expected.startsWith(":")) {
      if (!actual) return undefined;
      params[expected.slice(1)] = actual;
    } else if (expected !== actual) {
      return undefined;
    }
  }
  return params;
}

function listRunEvents(supervisor: RunSupervisor, runId: string): RunEvent[] {
  const collected: RunEvent[] = [];
  let cursor = 0;
  while (true) {
    const page = supervisor.events.listAfter(cursor, runId, 10_000);
    collected.push(...page);
    if (page.length < 10_000) return collected;
    cursor = page.at(-1)!.sequence;
  }
}

function streamEvents(
  request: IncomingMessage,
  response: ServerResponse,
  supervisor: RunSupervisor,
  runId?: string,
): void {
  const headerCursor = singleHeader(request.headers["last-event-id"]);
  const url = new URL(request.url ?? "/", "http://localhost");
  const cursorText = url.searchParams.get("after") ?? headerCursor ?? "0";
  const cursor = Number(cursorText);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new HttpError(400, "Event cursor must be a non-negative integer");
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write("retry: 2000\n\n");
  const write = (event: RunEvent): void => {
    if (!runId || event.runId === runId) {
      response.write(`id: ${event.sequence}\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };
  let replayCursor = cursor;
  while (true) {
    const events = supervisor.events.listAfter(replayCursor, runId, 1_000);
    for (const event of events) {
      write(event);
      replayCursor = event.sequence;
    }
    if (events.length < 1_000) {
      break;
    }
  }
  const unsubscribe = supervisor.events.subscribe(write);
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  heartbeat.unref();
  request.once("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function readJson(request: IncomingMessage, limit = maxBodyBytes): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limit) {
      throw new HttpError(413, "Request body is too large", "REQUEST_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON", "INVALID_REQUEST");
  }
}

export function buildPublicConfig(
  loaded: LoadedConfig,
  catalog?: StrategyBlueprintCatalog,
): unknown {
  const strategies = loaded.config.strategies
    ? {
        default: loaded.config.strategies.default,
        definitions: Object.fromEntries(
          Object.entries(loaded.config.strategies.definitions).map(([name, definition]) => [
            name,
            {
              ...definition,
              compiledTopology: resolveStrategy(loaded.config, name).topology,
              source: catalog?.source(name) ?? "config",
            },
          ]),
        ),
      }
    : {
        default: "legacy",
        definitions: {
          legacy: {
            maxParallel: loaded.config.project.maxParallel,
            maxReworkAttempts: loaded.config.quality.maxReworkAttempts,
            executionTimeoutSeconds: legacyExecutionTimeoutSeconds,
            maxAgentInvocations: legacyMaxAgentInvocations,
            maxProcessOutputBytes: legacyMaxProcessOutputBytes,
            maxArtifactBytes: legacyMaxArtifactBytes,
            roleProfiles: {},
            approvalGates: ["final"],
            approvalTimeoutSeconds: legacyApprovalTimeoutSeconds,
            compiledTopology: resolveStrategy(loaded.config).topology,
            source: "config",
          },
        },
      };
  return {
    project: loaded.config.project,
    profiles: Object.fromEntries(
      Object.entries(loaded.config.profiles).map(([name, profile]) => [
        name,
        {
          adapter: profile.adapter,
          model: profile.model,
          reasoning: profile.reasoning,
          permission: profile.permission,
          externalTools: profile.externalTools,
        },
      ]),
    ),
    roles: loaded.config.roles,
    strategies,
    observability: loaded.config.observability,
    interop: buildInteropManifest(loaded.config),
  };
}

function blueprintProjection(
  checked: CheckedStrategyBlueprint,
  source: "custom",
): unknown {
  return {
    name: checked.name,
    definition: {
      ...checked.definition,
      compiledTopology: checked.resolved.topology,
      source,
    },
    resolved: checked.resolved,
  };
}

function requireStrategyCatalog(context: ProjectHttpContext): StrategyBlueprintCatalog {
  if (!context.strategies) {
    throw new HttpError(503, "Strategy blueprint editing is unavailable");
  }
  return context.strategies;
}

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

function requireEvolutionSession(sessionOperator: string | undefined): string {
  if (!sessionOperator) {
    throw new HttpError(401, "A local control session is required", "SESSION_REQUIRED");
  }
  return sessionOperator;
}

async function dispatchDesktopApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  method: string,
  serverOrigin: string,
  sessionOperator: string | undefined,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/desktop")) {
    return false;
  }
  // Desktop session is required only when the control service was started with a session token.
  // Plain `agent-team serve` (no token) may use these local routes for development.
  if (sessionOperator === undefined) {
    // allow through for non-desktop local serve
  } else {
    requireEvolutionSession(sessionOperator);
  }

  if (method === "GET" && url.pathname === "/api/desktop/cli-inventory") {
    const refresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("refresh") === "true";
    const { inventory, fromCache, reason } = await getInventory({ refresh });
    sendJson(response, 200, { inventory, fromCache, reason });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/desktop/cli-inventory/scan") {
    requireDesktopMutation(request, serverOrigin, sessionOperator);
    const { inventory, fromCache, reason } = await getInventory({ refresh: true });
    sendJson(response, 200, { inventory, fromCache, reason });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/desktop/settings") {
    const settings = await loadDesktopSettings();
    const { inventory, fromCache, reason } = await getInventory({ refresh: false });
    // Re-load after getInventory may have rewritten the cache fingerprint.
    const latest = await loadDesktopSettings();
    const roleDefaults = mergeRoleDefaults(latest, inventory);
    sendJson(response, 200, {
      settings: {
        version: latest.version,
        defaults: { roles: roleDefaults },
        ui: {
          showCliPickerInRunLauncher: latest.ui.showCliPickerInRunLauncher,
          autoDetectCliConfig: latest.ui.autoDetectCliConfig,
          autoDetectOnFocus: latest.ui.autoDetectOnFocus,
        },
        inventoryCachedAt: latest.inventoryCachedAt ?? null,
      },
      inventory,
      fromCache,
      reason,
      suggestedDefaults: suggestDefaultsFromInventory(inventory),
    });
    return true;
  }

  if (method === "PUT" && url.pathname === "/api/desktop/settings") {
    requireDesktopMutation(request, serverOrigin, sessionOperator);
    const body = desktopSettingsUpdateSchema.parse(await readJson(request));
    const current = await loadDesktopSettings();
    const saved = await saveDesktopSettings({
      version: 1,
      inventoryCache: current.inventoryCache,
      inventoryCachedAt: current.inventoryCachedAt,
      inventorySourceFingerprint: current.inventorySourceFingerprint,
      defaults: body.defaults,
      ui: body.ui,
    });
    sendJson(response, 200, { settings: saved });
    return true;
  }

  throw new HttpError(404, "Desktop route not found");
}

function requireDesktopMutation(
  request: IncomingMessage,
  serverOrigin: string,
  sessionOperator: string | undefined,
): string {
  // When the server has a desktop session token, require cookie-backed operator + exact origin.
  // Local serve without a session token only checks Origin when the browser sends one.
  if (sessionOperator) {
    requireEvolutionSession(sessionOperator);
  }
  const origin = singleHeader(request.headers.origin);
  if (origin && origin !== serverOrigin) {
    throw new HttpError(403, "Desktop mutations require the exact local origin", "ORIGIN_DENIED");
  }
  return sessionOperator ?? "local-dev";
}

const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function invalidIdempotencyKey(): HttpError {
  return new HttpError(
    400,
    "Idempotency-Key must contain 1-128 safe identifier characters",
    "INVALID_IDEMPOTENCY_KEY",
  );
}

function optionalIdempotencyKey(request: IncomingMessage): string | undefined {
  const value = singleHeader(request.headers["idempotency-key"]);
  if (value === undefined) {
    return undefined;
  }
  if (!idempotencyKeyPattern.test(value)) {
    throw invalidIdempotencyKey();
  }
  return value;
}

function requireIdempotencyKey(request: IncomingMessage): string {
  const value = optionalIdempotencyKey(request);
  if (!value) {
    throw invalidIdempotencyKey();
  }
  return value;
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

function invalidRequest(messages: string[]): HttpError {
  return new HttpError(400, messages.join("; "), "INVALID_REQUEST");
}

function evolutionHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const message = error instanceof Error ? error.message : "Evolution request failed";
  if (error instanceof ProjectMutationConflictError) {
    return new HttpError(409, message, error.code);
  }
  if (error instanceof EvolutionApplicationError) {
    if (error.code === "PROPOSAL_NOT_FOUND") return new HttpError(404, message, error.code);
    if (error.code === "POLICY_DENIED") return new HttpError(403, message, error.code);
    if (error.code === "MATERIAL_MISSING" || error.code === "RECOVERY_REQUIRED") {
      return new HttpError(503, message, error.code);
    }
    return new HttpError(409, message, error.code);
  }
  if (error instanceof EvolutionServiceError) {
    if (error.code === "PROPOSAL_NOT_FOUND") {
      return new HttpError(404, message, error.code);
    }
    if (error.code === "PROMPT_ROLE_NOT_FOUND") {
      return new HttpError(400, message, error.code);
    }
    if (error.code === "SERVICE_CLOSED") {
      return new HttpError(503, message, error.code);
    }
    return new HttpError(409, message, error.code);
  }
  if (error instanceof AutomaticEvolutionError) {
    if (error.code === "AUTOMATION_DISABLED") {
      return new HttpError(403, message, error.code);
    }
    return new HttpError(409, message, error.code);
  }
  if (error instanceof EvolutionLifecycleError || error instanceof EvolutionPromotionError) {
    return new HttpError(409, message, "INVALID_LIFECYCLE");
  }
  if (error instanceof EvolutionValidationError) {
    return new HttpError(400, message, "INVALID_REQUEST");
  }
  if (error instanceof EvolutionPersistenceError) {
    return new HttpError(503, "Evolution persistence is unavailable", "EVOLUTION_UNAVAILABLE");
  }
  if (error instanceof EvolutionDomainError) {
    return new HttpError(400, message, "INVALID_REQUEST");
  }
  return new HttpError(500, "Evolution request failed", "INTERNAL_ERROR");
}

const runNotFoundMessage = /was not found/;
const runStateConflictMessage =
  /from status '|is already active|is still active|cannot be deleted|active child run|referenced as a parent|changed after preview|already has a response|is not the latest request|expired at |missing or expired|already used for another request|cannot be retried directly|no recoverable task-boundary checkpoint|requires approval before worker recovery/;
const runParameterMessage =
  /^Unknown (?:strategy|profile|role|fallback profile) |^Profile '.+' is not allowed|must be an integer|^Invalid run ID/;

function runActionHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ProjectMutationConflictError) {
    return new HttpError(409, message, error.code);
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

function strategyHttpError(error: unknown): HttpError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ProjectMutationConflictError) {
    return new HttpError(409, message, error.code);
  }
  if (error instanceof StrategyBlueprintConflictError) return new HttpError(409, message);
  if (error instanceof StrategyBlueprintNotFoundError) return new HttpError(404, message);
  return new HttpError(400, message);
}

function experienceHttpError(error: unknown): HttpError {
  const message = error instanceof Error ? error.message : String(error);
  if (/Unknown .* experience id/i.test(message)) {
    return new HttpError(404, message, "EXPERIENCE_NOT_FOUND");
  }
  if (/suiteDigest|forceWithoutSuite|requireSuiteForPromote/i.test(message)) {
    return new HttpError(409, message, "EXPERIENCE_SUITE_REQUIRED");
  }
  if (/cannot be promoted|cannot be rejected|cannot be retired|Only verified|Only low-sensitivity|project-bound/i.test(message)) {
    return new HttpError(409, message, "EXPERIENCE_STATE");
  }
  return new HttpError(400, message, "EXPERIENCE_ERROR");
}

function workspaceProjection(
  mode: "single" | "workspace",
  projects: ProjectHttpContext[],
): unknown {
  const connected = projects.map((project) => ({
    id: project.id,
    name: project.loaded.config.project.name,
    defaultBranch: project.loaded.config.project.defaultBranch,
    connected: true as const,
  }));
  const registry = readDesktopProjectRegistry(connected);
  return {
    mode,
    defaultProjectId: projects[0]!.id,
    projects: connected.map(({ id, name, defaultBranch }) => ({ id, name, defaultBranch })),
    connectedCount: connected.length,
    registeredCount: registry?.length ?? connected.length,
    registry,
  };
}

interface DesktopRegistryEntry {
  id: string;
  name: string;
  path: string;
  connected: boolean;
  occupancy?: string;
  reason?: string;
}

function readDesktopProjectRegistry(
  connected: Array<{ id: string; name: string; defaultBranch: string; connected: true }>,
): DesktopRegistryEntry[] | undefined {
  const registryPath = process.env.AGENT_TEAM_PROJECT_REGISTRY?.trim();
  if (!registryPath) {
    return connected.map((project) => ({
      id: project.id,
      name: project.name,
      path: "",
      connected: true,
      occupancy: "ours",
    }));
  }
  try {
    const raw = JSON.parse(readFileSync(registryPath, "utf8")) as {
      projects?: DesktopRegistryEntry[];
    };
    if (!Array.isArray(raw.projects) || raw.projects.length === 0) return undefined;
    const connectedIds = new Set(connected.map((project) => project.id));
    return raw.projects.map((entry) => ({
      ...entry,
      connected: connectedIds.has(entry.id),
    }));
  } catch {
    return undefined;
  }
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "Invalid URL path");
  }
}

function validateOrigin(request: IncomingMessage, serverOrigin: string): void {
  const origin = singleHeader(request.headers.origin);
  if (!origin) {
    return;
  }
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new HttpError(403, "Invalid request origin");
  }
  if (originUrl.origin !== serverOrigin) {
    throw new HttpError(403, "Cross-origin requests are not allowed");
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
}

async function serveWebAsset(
  response: ServerResponse,
  pathname: string,
  staticDirectory: string,
  headOnly: boolean,
): Promise<boolean> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "Invalid URL path");
  }
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  let candidate = path.resolve(staticDirectory, relativePath);
  const rootPrefix = `${path.resolve(staticDirectory)}${path.sep}`;
  if (!candidate.startsWith(rootPrefix)) {
    throw new HttpError(404, "Route not found");
  }
  let contents = await readFile(candidate).catch(() => undefined);
  if (!contents && !path.extname(relativePath)) {
    candidate = path.join(staticDirectory, "index.html");
    contents = await readFile(candidate).catch(() => undefined);
  }
  if (!contents) {
    return false;
  }
  response.writeHead(200, {
    "Content-Type": contentType(candidate),
    "Content-Length": contents.byteLength,
    "Cache-Control": relativePath.startsWith("assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  });
  response.end(headOnly ? undefined : contents);
  return true;
}

function contentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  }[extension] ?? "application/octet-stream";
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const serialized = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(serialized),
    "Cache-Control": "no-store",
  });
  response.end(serialized);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function assertLoopbackHost(host: string): void {
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(`Control service must bind to a loopback host, received '${host}'`);
  }
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

const bundledWebDirectory = fileURLToPath(new URL("../../web/dist", import.meta.url));
