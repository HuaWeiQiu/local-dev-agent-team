import type { LoadedConfig } from "../config/load.js";
import { buildInteropManifest } from "../interop/manifest.js";
import { resolveStrategy } from "../strategies/resolve.js";
import { legacyApprovalTimeoutSeconds, legacyExecutionTimeoutSeconds, legacyMaxAgentInvocations, legacyMaxArtifactBytes, legacyMaxProcessOutputBytes } from "../strategies/defaults.js";
import type { StrategyBlueprintCatalog } from "../strategies/catalog.js";
import { projectRoleSettingsUpdateSchema } from "./contracts.js";
import { loadLayeredRoleDisplay, saveProjectRoleSettings } from "../desktop/project-role-settings.js";
import { getInventory } from "../desktop/settings.js";
import { JevClient } from "../jev/client.js";
import { requireDesktopMutation } from "./http-routes-desktop.js";
import { HttpError, type ProjectApiRoute, readJson, sendJson } from "./http-common.js";
import { streamEvents } from "./http-sse.js";

export const projectRoutes: ProjectApiRoute[] = [
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
    method: "POST",
    pattern: "/jev/probe",
    handler: async (context, request, response, _url, _params, serverOrigin, sessionOperator) => {
      requireDesktopMutation(request, serverOrigin, sessionOperator);
      const jev = context.loaded.config.jev;
      if (!jev) {
        throw new HttpError(404, "agent-team.yaml 中没有 jev 配置", "JEV_NOT_CONFIGURED");
      }
      sendJson(response, 200, await new JevClient(jev).probe());
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
    pattern: "/interop",
    handler: (context, _request, response) => {
      sendJson(response, 200, buildInteropManifest(context.loaded.config));
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
];

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
    ...(loaded.config.jev ? { jev: loaded.config.jev } : {}),
    interop: buildInteropManifest(loaded.config),
  };
}
