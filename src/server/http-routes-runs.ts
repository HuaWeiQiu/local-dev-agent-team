import type { LoadedConfig } from "../config/load.js";
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
  experienceReasonRequestSchema,
  projectRoleSettingsUpdateSchema,
  resumeRunRequestSchema,
  pauseRunRequestSchema,
  startRunRequestSchema,
  strategyBlueprintPreflightRequestSchema,
  strategyBlueprintRequestSchema,
} from "./contracts.js";
import { ExperienceService } from "../experience/service.js";
import {
  loadLayeredRoleDisplay,
  resolveLayeredRoleBindings,
  saveProjectRoleSettings,
} from "../desktop/project-role-settings.js";
import { getInventory } from "../desktop/settings.js";
import { requireDesktopMutation } from "./http-routes-desktop.js";
import {
  ProjectMutationConflictError,
  RunNotFoundError,
  type RunSupervisor,
} from "./supervisor.js";
import {
  decodePathSegment,
  HttpError,
  optionalIdempotencyKey,
  type ProjectApiRoute,
  type ProjectHttpContext,
  readJson,
  sendJson,
  singleHeader,
} from "./http-common.js";
import { streamEvents } from "./http-sse.js";

export const runRoutes: ProjectApiRoute[] = [
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
    pattern: "/role-settings",
    handler: async (context, _request, response) => {
      const { inventory } = await getInventory({ refresh: false });
      const layered = await loadLayeredRoleDisplay({
        root: context.loaded.root,
        stateDirectory: context.loaded.config.project.stateDirectory,
        inventory,
      });
      sendJson(response, 200, {
        projectId: context.id,
        projectName: context.loaded.config.project.name,
        roles: layered.project,
        global: layered.global,
        effective: layered.effective,
        sources: layered.sources,
      });
    },
  },
  {
    method: "PUT",
    pattern: "/role-settings",
    handler: async (context, request, response, _url, _params, serverOrigin, sessionOperator) => {
      requireDesktopMutation(request, serverOrigin, sessionOperator);
      const body = projectRoleSettingsUpdateSchema.parse(await readJson(request));
      const roles = Object.fromEntries(
        Object.entries(body.roles).flatMap(([role, binding]) =>
          binding ? [[role, binding] as const] : [],
        ),
      );
      await saveProjectRoleSettings(
        context.loaded.root,
        context.loaded.config.project.stateDirectory,
        { version: 1, roles },
      );
      const { inventory } = await getInventory({ refresh: false });
      const layered = await loadLayeredRoleDisplay({
        root: context.loaded.root,
        stateDirectory: context.loaded.config.project.stateDirectory,
        inventory,
      });
      sendJson(response, 200, {
        projectId: context.id,
        projectName: context.loaded.config.project.name,
        roles: layered.project,
        global: layered.global,
        effective: layered.effective,
        sources: layered.sources,
      });
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
    handler: async (context, request, response, _url, _params, _serverOrigin, sessionOperator) => {
      const parsed = startRunRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      const idempotency = optionalIdempotencyKey(request);
      try {
        const started = await withLayeredRoleBindings(context, parsed.data, sessionOperator);
        const result = context.supervisor.start(started, idempotency);
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
    pattern: "/runs/:runId/actions/pause",
    handler: async (context, request, response, _url, params) => {
      const parsed = pauseRunRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      const runId = decodePathSegment(params.runId!);
      try {
        const paused = await context.supervisor.pause(runId, parsed.data);
        sendJson(response, 202, { runId, status: paused ? "pause-requested" : "not-active" });
      } catch (error) {
        throw runActionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/runs/:runId/actions/retry",
    handler: async (context, request, response, _url, params, _serverOrigin, sessionOperator) => {
      const runId = decodePathSegment(params.runId!);
      const idempotency = optionalIdempotencyKey(request);
      try {
        const fallbackRoleBindings = sessionOperator
          ? await resolveLayeredRoleBindings({
              root: context.loaded.root,
              stateDirectory: context.loaded.config.project.stateDirectory,
              knownRoles: Object.keys(context.loaded.config.roles),
            })
          : undefined;
        const result = await context.supervisor.retry(
          runId,
          idempotency,
          fallbackRoleBindings ? { fallbackRoleBindings } : undefined,
        );
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

async function withLayeredRoleBindings(
  context: ProjectHttpContext,
  request: import("./contracts.js").StartRunRequest,
  sessionOperator: string | undefined,
): Promise<import("./contracts.js").StartRunRequest> {
  if (request.roleBindings && Object.keys(request.roleBindings).length > 0) {
    return request;
  }
  if (!sessionOperator) return request;
  const roleBindings = await resolveLayeredRoleBindings({
    root: context.loaded.root,
    stateDirectory: context.loaded.config.project.stateDirectory,
    knownRoles: Object.keys(context.loaded.config.roles),
  });
  if (!roleBindings) return request;
  return { ...request, roleBindings };
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
