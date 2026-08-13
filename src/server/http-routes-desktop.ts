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
  if (!url.pathname.startsWith("/api/desktop")) {
    return false;
  }
  // Desktop session is required only when the control service was started with a session token.
  // Plain `agent-team serve` (no token) may use these local routes for development.
  if (sessionOperator === undefined) {
    // allow through for non-desktop local serve
  } else {
    requireEvolutionSession(sessionOperator);
  }

  if (method === "GET" && url.pathname === "/api/desktop/cli-inventory") {
    const refresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("refresh") === "true";
    const { inventory, fromCache, reason } = await getInventory({ refresh });
    sendJson(response, 200, { inventory, fromCache, reason });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/desktop/cli-inventory/scan") {
    requireDesktopMutation(request, serverOrigin, sessionOperator);
    const { inventory, fromCache, reason } = await getInventory({ refresh: true });
    sendJson(response, 200, { inventory, fromCache, reason });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/desktop/settings") {
    const settings = await loadDesktopSettings();
    const { inventory, fromCache, reason } = await getInventory({ refresh: false });
    // Re-load after getInventory may have rewritten the cache fingerprint.
    const latest = await loadDesktopSettings();
    const roleDefaults = mergeRoleDefaults(latest, inventory);
    sendJson(response, 200, {
      settings: {
        version: latest.version,
        defaults: { roles: roleDefaults },
        ui: {
          showCliPickerInRunLauncher: latest.ui.showCliPickerInRunLauncher,
          autoDetectCliConfig: latest.ui.autoDetectCliConfig,
          autoDetectOnFocus: latest.ui.autoDetectOnFocus,
        },
        inventoryCachedAt: latest.inventoryCachedAt ?? null,
      },
      inventory,
      fromCache,
      reason,
      suggestedDefaults: suggestDefaultsFromInventory(inventory),
    });
    return true;
  }

  if (method === "PUT" && url.pathname === "/api/desktop/settings") {
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
    return true;
  }

  throw new HttpError(404, "Desktop route not found");
}

function requireDesktopMutation(
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
