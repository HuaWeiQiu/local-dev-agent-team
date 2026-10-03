import { z } from "zod";
import { commandSchema } from "../config/schema.js";
import type { CliProbeResult } from "../desktop/cli-inventory.js";
import { getInventory } from "../desktop/settings.js";
import { detectRepository, type RepoDetection } from "../onboarding/detect.js";
import { pickStarterCli, saveQualityCommands } from "../onboarding/starter.js";
import { requireDesktopMutation } from "./http-routes-desktop.js";
import {
  HttpError,
  type ProjectApiRoute,
  type ProjectHttpContext,
  readJson,
  sendJson,
} from "./http-common.js";

const saveQualityRequestSchema = z.object({
  commands: z.array(commandSchema).max(16),
});

export interface OnboardingStatus {
  projectId: string;
  projectName: string;
  source: "file" | "detected";
  configPath: string;
  /** True while the project still runs on in-memory defaults or has no quality gate. */
  needsSetup: boolean;
  detection: RepoDetection;
  current: { commands: Array<{ command: string; args: string[] }> };
  clis: Array<{
    id: string;
    installed: boolean;
    runtimeSupported: boolean;
    version?: string;
    authStatus: CliProbeResult["auth"]["status"];
  }>;
  recommendedCli?: string;
}

async function buildStatus(context: ProjectHttpContext): Promise<OnboardingStatus> {
  const { loaded } = context;
  const [detection, inventoryResult] = await Promise.all([
    detectRepository(loaded.root),
    getInventory({ refresh: false }).catch(() => undefined),
  ]);
  const inventory = inventoryResult?.inventory;
  const recommended = pickStarterCli(inventory);
  const source = loaded.source ?? "file";
  return {
    projectId: context.id,
    projectName: loaded.config.project.name,
    source,
    configPath: loaded.path,
    needsSetup: source === "detected" || loaded.config.quality.commands.length === 0,
    detection,
    current: {
      commands: loaded.config.quality.commands.map((command) => ({
        command: command.command,
        args: [...command.args],
      })),
    },
    clis: (inventory?.clis ?? []).map((cli) => ({
      id: cli.id,
      installed: cli.installed,
      runtimeSupported: cli.runtimeSupported,
      ...(cli.version ? { version: cli.version } : {}),
      authStatus: cli.auth.status,
    })),
    ...(recommended ? { recommendedCli: recommended.id } : {}),
  };
}

export const onboardingRoutes: ProjectApiRoute[] = [
  {
    method: "GET",
    pattern: "/onboarding",
    handler: async (context, _request, response) => {
      sendJson(response, 200, await buildStatus(context));
    },
  },
  {
    method: "PUT",
    pattern: "/onboarding/quality",
    handler: async (context, request, response, _url, _params, serverOrigin, sessionOperator) => {
      requireDesktopMutation(request, serverOrigin, sessionOperator);
      const body = saveQualityRequestSchema.parse(await readJson(request));
      try {
        await saveQualityCommands(context.loaded, body.commands);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new HttpError(
            409,
            "agent-team.yaml was created after this project started; restart to pick it up",
            "CONFIG_FILE_EXISTS",
          );
        }
        throw error;
      }
      sendJson(response, 200, await buildStatus(context));
    },
  },
];
