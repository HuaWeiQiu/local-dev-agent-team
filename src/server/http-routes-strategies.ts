import { type StrategyBlueprintCatalog, StrategyBlueprintConflictError, StrategyBlueprintNotFoundError, type CheckedStrategyBlueprint } from "../strategies/catalog.js";
import { strategyBlueprintPreflightRequestSchema, strategyBlueprintRequestSchema } from "./contracts.js";
import { ProjectMutationConflictError } from "./supervisor.js";
import { decodePathSegment, HttpError, type ProjectApiRoute, type ProjectHttpContext, readJson, sendJson } from "./http-common.js";

export const strategyRoutes: ProjectApiRoute[] = [
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
];

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

function strategyHttpError(error: unknown): HttpError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ProjectMutationConflictError) {
    return new HttpError(409, message, error.code);
  }
  if (error instanceof StrategyBlueprintConflictError) return new HttpError(409, message);
  if (error instanceof StrategyBlueprintNotFoundError) return new HttpError(404, message);
  return new HttpError(400, message);
}
