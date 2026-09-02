import { inquiryRequestSchema } from "./contracts.js";
import {
  HttpError,
  type ProjectApiRoute,
  readJson,
  sendJson,
} from "./http-common.js";
import { decodePathSegment } from "./http-common.js";

export const inquiryRoutes: ProjectApiRoute[] = [
  {
    method: "POST",
    pattern: "/runs/:runId/inquiries",
    handler: async (context, request, response, _url, params) => {
      const runId = decodePathSegment(params.runId!);
      const parsed = inquiryRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      try {
        const inquiry = await context.supervisor.askInquiry(
          runId,
          parsed.data.question,
          parsed.data.stage,
        );
        sendJson(response, 202, { inquiry });
      } catch (error) {
        throw inquiryHttpError(error);
      }
    },
  },
  {
    method: "GET",
    pattern: "/runs/:runId/inquiries",
    handler: async (context, _request, response, _url, params) => {
      const runId = decodePathSegment(params.runId!);
      try {
        sendJson(response, 200, { inquiries: await context.supervisor.listInquiries(runId) });
      } catch (error) {
        throw inquiryHttpError(error);
      }
    },
  },
  {
    method: "GET",
    pattern: "/runs/:runId/inquiries/:inquiryId",
    handler: async (context, _request, response, _url, params) => {
      const runId = decodePathSegment(params.runId!);
      const inquiryId = decodePathSegment(params.inquiryId!);
      try {
        sendJson(response, 200, { inquiry: await context.supervisor.getInquiry(runId, inquiryId) });
      } catch (error) {
        throw inquiryHttpError(error);
      }
    },
  },
  {
    method: "DELETE",
    pattern: "/runs/:runId/inquiries/:inquiryId",
    handler: async (context, _request, response, _url, params) => {
      const runId = decodePathSegment(params.runId!);
      const inquiryId = decodePathSegment(params.inquiryId!);
      try {
        await context.supervisor.deleteInquiry(runId, inquiryId);
        sendJson(response, 200, { deleted: true });
      } catch (error) {
        throw inquiryHttpError(error);
      }
    },
  },
];

function inquiryHttpError(error: unknown): HttpError {
  const message = error instanceof Error ? error.message : String(error);
  const status = /limit|in-flight/i.test(message) ? 409 : 400;
  return new HttpError(status, message, "INQUIRY_ACTION_FAILED");
}
