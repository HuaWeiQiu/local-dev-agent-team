/**
 * The webhook door.
 *
 * `POST /intake/github` hands one GitHub event to the supervisor, which admits it
 * through the gate and starts work only for an accept. The route itself decides
 * nothing: it checks that this deployment accepts webhooks at all, reads the
 * body, and reports what the supervisor did.
 *
 * The switch is off by default and lives on the supervisor, not here, so a route
 * cannot accidentally enable a capability the deployment did not ask for.
 */

import { z } from "zod";
import { attentionQueue, workingCount } from "../authority/attention.js";
import { HttpError, readJson, sendJson, type ProjectApiRoute } from "./http-common.js";

/** One webhook: the event name, its payload, and who counts as the agent. */
const githubIntakeRequestSchema = z.object({
  event: z.string().trim().min(1).max(64),
  payload: z.unknown(),
  /** The logins this agent posts under; a comment naming one addresses it. */
  agentLogins: z.array(z.string().trim().min(1)).max(16).optional(),
  /** The repository this Source is configured for. */
  instanceId: z.string().trim().min(1).optional(),
});

export const intakeRoutes: ProjectApiRoute[] = [
  {
    method: "GET",
    pattern: "/tickets",
    handler: async (context, _request, response) => {
      const tickets = await context.supervisor.listTickets();
      sendJson(response, 200, {
        attention: attentionQueue(tickets),
        working: workingCount(tickets),
        total: tickets.length,
      });
    },
  },
  {
    method: "POST",
    pattern: "/intake/github",
    handler: async (context, request, response) => {
      if (!context.supervisor.intakeEnabled) {
        throw new HttpError(
          409,
          "This deployment does not accept work from webhooks; enable intake to use this route",
          "INTAKE_DISABLED",
        );
      }
      const body = githubIntakeRequestSchema.parse(await readJson(request));
      const result = await context.supervisor.admitEvent({
        event: body.event,
        payload: body.payload,
        agentLogins: body.agentLogins,
        instanceId: body.instanceId,
      });
      sendJson(response, 202, result);
    },
  },
];
