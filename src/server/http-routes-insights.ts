import type { RunSupervisor } from "./supervisor.js";
import { decodePathSegment, HttpError, type ProjectApiRoute, sendJson } from "./http-common.js";
import { RunNotFound } from "../visibility/service.js";

export function insightRoutes(): ProjectApiRoute[] {
  const insight = (
    pattern: string,
    read: (
      insights: RunSupervisor["insights"],
      runId: string,
      params: Record<string, string>,
      url: URL,
    ) => Promise<unknown>,
  ): ProjectApiRoute => ({
    method: "GET",
    pattern,
    handler: async (context, _request, response, url, params) => {
      try {
        const body = await read(
          context.supervisor.insights,
          decodePathSegment(params.runId!),
          params as Record<string, string>,
          url,
        );
        if (body === undefined) throw new HttpError(404, "Not found");
        sendJson(response, 200, body);
      } catch (error) {
        if (error instanceof RunNotFound) throw new HttpError(404, error.message);
        if (error instanceof HttpError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new HttpError(400, message);
      }
    },
  });
  return [
    insight("/runs/:runId/explain", async (insights, runId) => ({ explanation: await insights.explain(runId) })),
    insight("/runs/:runId/usage", async (insights, runId) => ({ usage: await insights.usage(runId) })),
    insight("/runs/:runId/replay", async (insights, runId) => ({ steps: await insights.replay(runId) })),
    insight("/runs/:runId/transcripts", async (insights, runId) => ({
      transcripts: await insights.transcripts(runId),
    })),
    insight("/runs/:runId/transcript", async (insights, runId, _params, url) => {
      const id = url.searchParams.get("id");
      if (!id) throw new HttpError(400, "Transcript id is required");
      const transcript = await insights.transcript(runId, id);
      return transcript ? { transcript } : undefined;
    }),
    insight("/runs/:runId/tasks/:taskId/diff", async (insights, runId, params) => ({
      diff: await insights.taskDiff(runId, decodePathSegment(params.taskId!)),
    })),
  ];
}
