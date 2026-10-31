import { experienceReasonRequestSchema } from "./contracts.js";
import { ExperienceService } from "../experience/service.js";
import { decodePathSegment, HttpError, type ProjectApiRoute, readJson, sendJson, singleHeader } from "./http-common.js";

export const experienceRoutes: ProjectApiRoute[] = [
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
];

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
