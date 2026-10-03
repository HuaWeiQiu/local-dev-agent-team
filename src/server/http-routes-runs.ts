import { buildOtlpTraceExport } from "../observability/otlp.js";
import { approvalResponseRequestSchema, cleanupPreviewRequestSchema, cleanupRunRequestSchema, resumeRunRequestSchema, pauseRunRequestSchema, startRunRequestSchema } from "./contracts.js";
import { resolveLayeredRoleBindings } from "../desktop/project-role-settings.js";
import { decodePathSegment, HttpError, optionalIdempotencyKey, type ProjectApiRoute, type ProjectHttpContext, readJson, sendJson } from "./http-common.js";
import { listRunEvents, runActionHttpError } from "./http-route-support.js";

export const runRoutes: ProjectApiRoute[] = [
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
    pattern: "/runs/:runId/actions/publish",
    handler: async (context, _request, response, _url, params) => {
      const runId = decodePathSegment(params.runId!);
      try {
        const result = await context.supervisor.publish(runId);
        sendJson(response, 202, result);
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
