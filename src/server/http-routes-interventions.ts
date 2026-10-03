import { foldFlowEvents } from "../flow/fold.js";
import { answerAgentRequestSchema, editPlanRequestSchema, interruptAgentRequestSchema, steerAgentRequestSchema } from "./contracts.js";
import { decodePathSegment, HttpError, type ProjectApiRoute, readJson, sendJson } from "./http-common.js";
import { listRunEvents, runActionHttpError } from "./http-route-support.js";

export const interventionRoutes: ProjectApiRoute[] = [
  {
    method: "GET",
    pattern: "/runs/:runId/agents",
    handler: async (context, _request, response, _url, params) => {
      const runId = decodePathSegment(params.runId!);
      if (!(await context.supervisor.get(runId))) {
        throw new HttpError(404, "Run not found");
      }
      sendJson(response, 200, { agents: context.supervisor.listAgents(runId) });
    },
  },
  {
    method: "POST",
    pattern: "/runs/:runId/agents/:agentId/steer",
    handler: async (context, request, response, _url, params) => {
      const parsed = steerAgentRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      try {
        await context.supervisor.steerAgent(
          decodePathSegment(params.runId!),
          decodePathSegment(params.agentId!),
          parsed.data,
        );
        sendJson(response, 202, { ok: true });
      } catch (error) {
        throw runActionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/runs/:runId/agents/:agentId/interrupt",
    handler: async (context, request, response, _url, params) => {
      const parsed = interruptAgentRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      try {
        await context.supervisor.interruptAgent(
          decodePathSegment(params.runId!),
          decodePathSegment(params.agentId!),
          parsed.data,
        );
        sendJson(response, 202, { ok: true });
      } catch (error) {
        throw runActionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/runs/:runId/agents/:agentId/answer",
    handler: async (context, request, response, _url, params) => {
      const parsed = answerAgentRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      try {
        await context.supervisor.answerAgent(
          decodePathSegment(params.runId!),
          decodePathSegment(params.agentId!),
          parsed.data,
        );
        sendJson(response, 202, { ok: true });
      } catch (error) {
        throw runActionHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/runs/:runId/actions/edit-plan",
    handler: async (context, request, response, _url, params) => {
      const parsed = editPlanRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      try {
        sendJson(
          response,
          200,
          await context.supervisor.editPlan(decodePathSegment(params.runId!), parsed.data),
        );
      } catch (error) {
        throw runActionHttpError(error);
      }
    },
  },
  {
    method: "GET",
    pattern: "/runs/:runId/flow",
    handler: async (context, _request, response, _url, params) => {
      const runId = decodePathSegment(params.runId!);
      if (!(await context.supervisor.get(runId))) {
        throw new HttpError(404, "Run not found");
      }
      sendJson(response, 200, foldFlowEvents(listRunEvents(context.supervisor, runId)));
    },
  },
];
