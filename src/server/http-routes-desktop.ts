import type { IncomingMessage, ServerResponse } from "node:http";
import { getInventory } from "../desktop/settings.js";
import {
  loadDesktopSettings,
  mergeRoleDefaults,
  saveDesktopSettings,
  suggestDefaultsFromInventory,
} from "../desktop/settings.js";
import { desktopSettingsUpdateSchema } from "./contracts.js";
import {
  HttpError,
  readJson,
  requireEvolutionSession,
  sendJson,
  singleHeader,
} from "./http-common.js";

export async function dispatchDesktopApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  method: string,
  serverOrigin: string,
  sessionOperator: string | undefined,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/desktop")) return false;
  // A desktop session token, when the service has one, gates every route here.
  if (sessionOperator !== undefined) requireEvolutionSession(sessionOperator);
  await handleDesktopRoute(request, response, url, method, serverOrigin, sessionOperator);
  return true;
}

/** The three desktop endpoints; a miss falls through to the caller's 404. */
async function handleDesktopRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  method: string,
  serverOrigin: string,
  sessionOperator: string | undefined,
): Promise<void> {
  switch (desktopRouteFor(method, url.pathname)) {
    case "inventory":
      await inventoryRoute(response, url);
      return;
    case "scan":
      await scanRoute(request, response, serverOrigin, sessionOperator);
      return;
    case "settings-get":
      await settingsGetRoute(response);
      return;
    case "settings-put":
      await settingsPutRoute(request, response, serverOrigin, sessionOperator);
      return;
    default:
      throw new HttpError(404, "Desktop route not found");
  }
}

type DesktopRoute = "inventory" | "scan" | "settings-get" | "settings-put";

const DESKTOP_ROUTES: Record<string, DesktopRoute> = {
  "GET /api/desktop/cli-inventory": "inventory",
  "POST /api/desktop/cli-inventory/scan": "scan",
  "GET /api/desktop/settings": "settings-get",
  "PUT /api/desktop/settings": "settings-put",
};

function desktopRouteFor(method: string, pathname: string): DesktopRoute | undefined {
  return DESKTOP_ROUTES[`${method} ${pathname}`];
}

function wantsRefresh(url: URL): boolean {
  const refresh = url.searchParams.get("refresh");
  return refresh === "1" || refresh === "true";
}

async function inventoryRoute(response: ServerResponse, url: URL): Promise<void> {
  const { inventory, fromCache, reason } = await getInventory({ refresh: wantsRefresh(url) });
  sendJson(response, 200, { inventory, fromCache, reason });
}

async function scanRoute(
  request: IncomingMessage,
  response: ServerResponse,
  serverOrigin: string,
  sessionOperator: string | undefined,
): Promise<void> {
  requireDesktopMutation(request, serverOrigin, sessionOperator);
  const { inventory, fromCache, reason } = await getInventory({ refresh: true });
  sendJson(response, 200, { inventory, fromCache, reason });
}

/** Load the inventory first: it may rewrite the cache fingerprint. */
async function settingsGetRoute(response: ServerResponse): Promise<void> {
  await loadDesktopSettings();
  const { inventory, fromCache, reason } = await getInventory({ refresh: false });
  const latest = await loadDesktopSettings();
  sendJson(response, 200, {
    settings: publicSettings(latest, inventory),
    inventory,
    fromCache,
    reason,
    suggestedDefaults: suggestDefaultsFromInventory(inventory),
  });
}

function publicSettings(
  latest: Awaited<ReturnType<typeof loadDesktopSettings>>,
  inventory: Awaited<ReturnType<typeof getInventory>>["inventory"],
): Record<string, unknown> {
  return {
    version: 1,
    defaults: { roles: mergeRoleDefaults(latest, inventory) },
    ui: {
      showCliPickerInRunLauncher: latest.ui.showCliPickerInRunLauncher,
      autoDetectCliConfig: latest.ui.autoDetectCliConfig,
      autoDetectOnFocus: latest.ui.autoDetectOnFocus,
    },
    inventoryCachedAt: latest.inventoryCachedAt ?? null,
  };
}

async function settingsPutRoute(
  request: IncomingMessage,
  response: ServerResponse,
  serverOrigin: string,
  sessionOperator: string | undefined,
): Promise<void> {
  requireDesktopMutation(request, serverOrigin, sessionOperator);
  const body = desktopSettingsUpdateSchema.parse(await readJson(request));
  const current = await loadDesktopSettings();
  const saved = await saveDesktopSettings({
    version: 1,
    inventoryCache: current.inventoryCache,
    inventoryCachedAt: current.inventoryCachedAt,
    inventorySourceFingerprint: current.inventorySourceFingerprint,
    defaults: body.defaults,
    ui: body.ui,
  });
  sendJson(response, 200, { settings: saved });
}

export function requireDesktopMutation(
  request: IncomingMessage,
  serverOrigin: string,
  sessionOperator: string | undefined,
): string {
  // When the server has a desktop session token, require cookie-backed operator + exact origin.
  // Local serve without a session token only checks Origin when the browser sends one.
  if (sessionOperator) {
    requireEvolutionSession(sessionOperator);
  }
  const origin = singleHeader(request.headers.origin);
  if (origin && origin !== serverOrigin) {
    throw new HttpError(403, "Desktop mutations require the exact local origin", "ORIGIN_DENIED");
  }
  return sessionOperator ?? "local-dev";
}
