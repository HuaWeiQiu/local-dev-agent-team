import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { LoadedConfig } from "../config/load.js";
import type { StrategyBlueprintCatalog } from "../strategies/catalog.js";
import type { EvolutionProjectService } from "./evolution-service.js";
import type { RunSupervisor } from "./supervisor.js";
import {
  decodePathSegment,
  HttpError,
  isApiPath,
  type ProjectApiRoute,
  type ProjectHttpContext,
  sendJson,
  singleHeader,
} from "./http-common.js";
import { onboardingRoutes } from "./http-routes-onboarding.js";
import { experienceRoutes } from "./http-routes-experience.js";
import { insightRoutes } from "./http-routes-insights.js";
import { interventionRoutes } from "./http-routes-interventions.js";
import { projectRoutes } from "./http-routes-project.js";
import { runRoutes } from "./http-routes-runs.js";
import { strategyRoutes } from "./http-routes-strategies.js";
import { evolutionRoutes } from "./http-routes-evolution.js";
import { dispatchDesktopApi } from "./http-routes-desktop.js";
import { serveWebAsset } from "./http-static.js";

export type { ProjectHttpContext } from "./http-common.js";
export { buildPublicConfig } from "./http-routes-project.js";

const desktopSessionPath = "/__agent_team/session";
const desktopSessionTokenPattern = /^[a-f0-9]{64}$/;

interface HttpServerOptions {
  host: string;
  port: number;
  staticDirectory?: string;
  sessionToken?: string;
}

export interface ListeningControlServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export async function listenControlServer(
  loaded: LoadedConfig,
  supervisor: RunSupervisor,
  options: {
    host: string;
    port: number;
    staticDirectory?: string;
    strategyCatalog?: StrategyBlueprintCatalog;
    evolutionService?: EvolutionProjectService;
    sessionToken?: string;
  },
): Promise<ListeningControlServer> {
  const context: ProjectHttpContext = {
    id: "default",
    loaded,
    supervisor,
    ...(options.strategyCatalog ? { strategies: options.strategyCatalog } : {}),
    ...(options.evolutionService ? { evolution: options.evolutionService } : {}),
  };
  return await listenHttpServer(
    (request, response, staticDirectory, serverOrigin, sessionOperator) =>
      handleSingleProjectRequest(
        context,
        request,
        response,
        staticDirectory,
        serverOrigin,
        sessionOperator,
      ),
    options,
  );
}

export async function listenWorkspaceServer(
  projects: ProjectHttpContext[],
  options: HttpServerOptions,
): Promise<ListeningControlServer> {
  if (projects.length === 0) {
    throw new Error("A workspace control server requires at least one project");
  }
  const byId = new Map(projects.map((project) => [project.id, project]));
  if (byId.size !== projects.length) {
    throw new Error("Workspace project IDs must be unique");
  }
  return await listenHttpServer(
    (request, response, staticDirectory, serverOrigin, sessionOperator) =>
      handleWorkspaceRequest(
        projects,
        byId,
        request,
        response,
        staticDirectory,
        serverOrigin,
        sessionOperator,
      ),
    options,
  );
}

async function listenHttpServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    staticDirectory: string,
    serverOrigin: string,
    sessionOperator: string | undefined,
  ) => Promise<void>,
  options: HttpServerOptions,
): Promise<ListeningControlServer> {
  assertServerOptions(options);
  const staticDirectory = options.staticDirectory ?? bundledWebDirectory;
  let serverOrigin = "";
  const sessionOperator = sessionOperatorFor(options.sessionToken);
  const server = createServer((request, response) => {
    setSecurityHeaders(response);
    void runRequest(request, response, {
      sessionToken: options.sessionToken,
      handler,
      staticDirectory,
      origin: () => serverOrigin,
      sessionOperator,
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const url = `http://${formatHost(options.host)}:${address.port}`;
  serverOrigin = url;
  let closePromise: Promise<void> | undefined;
  return {
    server,
    url,
    close: () => {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      return closePromise;
    },
  };
}

/**
 * One request: the session handshake first, then the caller's handler, and one
 * place that turns a thrown error into a response.
 */
async function runRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    sessionToken: string | undefined;
    handler: (
      request: IncomingMessage,
      response: ServerResponse,
      staticDirectory: string,
      serverOrigin: string,
      sessionOperator: string | undefined,
    ) => Promise<void>;
    staticDirectory: string;
    origin: () => string;
    sessionOperator: string | undefined;
  },
): Promise<void> {
  try {
    if (await handleDesktopSession(request, response, context.sessionToken)) return;
    await context.handler(
      request,
      response,
      context.staticDirectory,
      context.origin(),
      context.sessionOperator,
    );
  } catch (error) {
    respondWithError(response, error);
  }
}

function respondWithError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  sendJson(response, ...errorBody(error));
}

/** One place decides what a client is told: its own error, or a generic 500. */
function errorBody(error: unknown): [number, { error: string; code: string }] {
  if (error instanceof HttpError) {
    return [error.status, { error: error.message, code: error.code ?? "REQUEST_FAILED" }];
  }
  return [500, { error: "Internal server error", code: "INTERNAL_ERROR" }];
}

/** The listen host and session token are checked before the socket opens. */
function assertServerOptions(options: HttpServerOptions): void {
  assertLoopbackHost(options.host);
  if (options.sessionToken && !desktopSessionTokenPattern.test(options.sessionToken)) {
    throw new Error("Desktop session token must contain 64 lowercase hexadecimal characters");
  }
}

/** A desktop session names its operator without keeping the token. */
function sessionOperatorFor(sessionToken: string | undefined): string | undefined {
  if (!sessionToken) return undefined;
  const digest = createHash("sha256").update(sessionToken).digest("hex").slice(0, 16);
  return `local-session:${digest}`;
}

function handleDesktopSession(
  request: IncomingMessage,
  response: ServerResponse,
  sessionToken: string | undefined,
): boolean {
  if (!sessionToken) return false;
  const cookieName = desktopSessionCookieName(sessionToken);
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname === desktopSessionPath) {
    if (
      request.method !== "GET" ||
      !secureEqual(url.searchParams.get("token"), sessionToken)
    ) {
      throw new HttpError(401, "Desktop session could not be established");
    }
    response.writeHead(303, {
      Location: "/?desktop-runtime=1",
      "Set-Cookie": `${cookieName}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`,
      "Cache-Control": "no-store",
    });
    response.end();
    return true;
  }
  if (isApiPath(url.pathname) && !hasDesktopSession(request, cookieName, sessionToken)) {
    throw new HttpError(401, "Desktop session is required");
  }
  return false;
}

function hasDesktopSession(
  request: IncomingMessage,
  cookieName: string,
  sessionToken: string,
): boolean {
  const cookieHeader = singleHeader(request.headers.cookie);
  if (!cookieHeader) return false;
  const value = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  return secureEqual(value, sessionToken);
}

function desktopSessionCookieName(sessionToken: string): string {
  const suffix = createHash("sha256").update(sessionToken).digest("hex").slice(0, 16);
  return `agent_team_session_${suffix}`;
}

function secureEqual(candidate: string | null | undefined, expected: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** `/api/projects/:id/...` belongs to one project; anything else is not ours. */
async function dispatchProjectScoped(
  byId: Map<string, ProjectHttpContext>,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  serverOrigin: string,
  sessionOperator: string | undefined,
): Promise<boolean> {
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/|$)/);
  if (!match?.[1]) return false;
  const context = byId.get(decodePathSegment(match[1]));
  if (!context) throw new HttpError(404, "Project not found");
  return await dispatchProjectApi(
    context,
    request,
    response,
    url,
    `/api/projects/${match[1]}`,
    serverOrigin,
    sessionOperator,
  );
}

/** Every API request starts the same way: security headers, origin, target. */
function beginApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  serverOrigin: string,
): { url: URL; method: string } {
  setSecurityHeaders(response);
  validateOrigin(request, serverOrigin);
  return { url: requestUrl(request), method: request.method ?? "GET" };
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
}

/** A request no route claimed is served as a web asset or reported as missing. */
async function finishApiRequest(
  response: ServerResponse,
  url: URL,
  method: string,
  staticDirectory: string,
): Promise<void> {
  const readable = method === "GET" || method === "HEAD";
  if (readable && !isApiPath(url.pathname)) {
    if (await serveWebAsset(response, url.pathname, staticDirectory, method === "HEAD")) return;
  }
  throw new HttpError(404, "Route not found");
}

async function handleSingleProjectRequest(
  context: ProjectHttpContext,
  request: IncomingMessage,
  response: ServerResponse,
  staticDirectory: string,
  serverOrigin: string,
  sessionOperator: string | undefined,
): Promise<void> {
  const { url, method } = beginApiRequest(request, response, serverOrigin);

  if (method === "GET" && url.pathname === "/api/workspace") {
    sendJson(response, 200, workspaceProjection("single", [context]));
    return;
  }
  if (await dispatchDesktopApi(request, response, url, method, serverOrigin, sessionOperator)) {
    return;
  }
  if (
    await dispatchProjectApi(
      context,
      request,
      response,
      url,
      "/api",
      serverOrigin,
      sessionOperator,
    )
  ) {
    return;
  }
  await finishApiRequest(response, url, method, staticDirectory);
}

async function handleWorkspaceRequest(
  projects: ProjectHttpContext[],
  byId: Map<string, ProjectHttpContext>,
  request: IncomingMessage,
  response: ServerResponse,
  staticDirectory: string,
  serverOrigin: string,
  sessionOperator: string | undefined,
): Promise<void> {
  const { url, method } = beginApiRequest(request, response, serverOrigin);

  if (method === "GET" && (url.pathname === "/api/workspace" || url.pathname === "/api/projects")) {
    sendJson(response, 200, workspaceProjection("workspace", projects));
    return;
  }
  if (method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      status: "ok",
      mode: "workspace",
      projectCount: projects.length,
    });
    return;
  }
  if (await dispatchDesktopApi(request, response, url, method, serverOrigin, sessionOperator)) {
    return;
  }
  if (await dispatchProjectScoped(byId, request, response, url, serverOrigin, sessionOperator)) {
    return;
  }
  await finishApiRequest(response, url, method, staticDirectory);
}

// Route matching is unambiguous across slices (no two patterns share method,
// segment count, and static segments), so concatenation order cannot change
// which handler a request resolves to.
const projectApiRoutes: ProjectApiRoute[] = [
  ...projectRoutes,
  ...runRoutes,
  ...interventionRoutes,
  ...insightRoutes(),
  ...experienceRoutes,
  ...strategyRoutes,
  ...evolutionRoutes,
  ...onboardingRoutes,
];

async function dispatchProjectApi(
  context: ProjectHttpContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  apiRoot: string,
  serverOrigin: string,
  sessionOperator: string | undefined,
): Promise<boolean> {
  if (url.pathname !== apiRoot && !url.pathname.startsWith(`${apiRoot}/`)) {
    return false;
  }
  const localPath = url.pathname.slice(apiRoot.length) || "/";
  const method = request.method ?? "GET";
  for (const route of projectApiRoutes) {
    if (route.method !== method) continue;
    const params = matchRoutePattern(route.pattern, localPath);
    if (!params) continue;
    await route.handler(
      context,
      request,
      response,
      url,
      params,
      serverOrigin,
      sessionOperator,
    );
    return true;
  }
  return false;
}

function matchRoutePattern(
  pattern: string,
  localPath: string,
): Record<string, string> | undefined {
  const patternSegments = pattern.split("/");
  const pathSegments = localPath.split("/");
  if (patternSegments.length !== pathSegments.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index]!;
    const actual = pathSegments[index]!;
    if (expected.startsWith(":")) {
      if (!actual) return undefined;
      params[expected.slice(1)] = actual;
    } else if (expected !== actual) {
      return undefined;
    }
  }
  return params;
}

function workspaceProjection(
  mode: "single" | "workspace",
  projects: ProjectHttpContext[],
): unknown {
  const connected = projects.map((project) => ({
    id: project.id,
    name: project.loaded.config.project.name,
    defaultBranch: project.loaded.config.project.defaultBranch,
    connected: true as const,
  }));
  const registry = readDesktopProjectRegistry(connected);
  return {
    mode,
    defaultProjectId: projects[0]!.id,
    projects: connected.map(({ id, name, defaultBranch }) => ({ id, name, defaultBranch })),
    connectedCount: connected.length,
    registeredCount: registry?.length ?? connected.length,
    registry,
  };
}

interface DesktopRegistryEntry {
  id: string;
  name: string;
  path: string;
  connected: boolean;
  occupancy?: string;
  reason?: string;
}

function readDesktopProjectRegistry(
  connected: Array<{ id: string; name: string; defaultBranch: string; connected: true }>,
): DesktopRegistryEntry[] | undefined {
  const registryPath = process.env.AGENT_TEAM_PROJECT_REGISTRY?.trim();
  if (!registryPath) return connectedOnly(connected);
  return readRegistry(registryPath, connected);
}

/** Without a registry file, the projects this process serves are the whole list. */
export function connectedOnly(
  connected: Array<{ id: string; name: string; defaultBranch: string; connected: true }>,
): DesktopRegistryEntry[] {
  return connected.map((project) => ({
    id: project.id,
    name: project.name,
    path: "",
    connected: true,
    occupancy: "ours",
  }));
}

/** A registry file lists every known project and flags the ones served here. */
export function readRegistry(
  registryPath: string,
  connected: Array<{ id: string }>,
): DesktopRegistryEntry[] | undefined {
  try {
    const raw = JSON.parse(readFileSync(registryPath, "utf8")) as {
      projects?: DesktopRegistryEntry[];
    };
    if (!Array.isArray(raw.projects) || raw.projects.length === 0) return undefined;
    const connectedIds = new Set(connected.map((project) => project.id));
    return raw.projects.map((entry) => ({ ...entry, connected: connectedIds.has(entry.id) }));
  } catch {
    return undefined;
  }
}

function validateOrigin(request: IncomingMessage, serverOrigin: string): void {
  const origin = singleHeader(request.headers.origin);
  if (!origin) {
    return;
  }
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new HttpError(403, "Invalid request origin");
  }
  if (originUrl.origin !== serverOrigin) {
    throw new HttpError(403, "Cross-origin requests are not allowed");
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
}

function assertLoopbackHost(host: string): void {
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(`Control service must bind to a loopback host, received '${host}'`);
  }
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

const bundledWebDirectory = fileURLToPath(new URL("../../web/dist", import.meta.url));
