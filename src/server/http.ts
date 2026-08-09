import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LoadedConfig } from "../config/load.js";
import type { RunEvent } from "../events/types.js";
import { buildOtlpTraceExport } from "../observability/otlp.js";
import { buildInteropManifest } from "../interop/manifest.js";
import { resolveStrategy } from "../strategies/resolve.js";
import {
  StrategyBlueprintCatalog,
  StrategyBlueprintConflictError,
  StrategyBlueprintNotFoundError,
  type CheckedStrategyBlueprint,
} from "../strategies/catalog.js";
import {
  approvalResponseRequestSchema,
  cleanupPreviewRequestSchema,
  cleanupRunRequestSchema,
  resumeRunRequestSchema,
  startRunRequestSchema,
  strategyBlueprintPreflightRequestSchema,
  strategyBlueprintRequestSchema,
} from "./contracts.js";
import type { RunSupervisor } from "./supervisor.js";

const maxBodyBytes = 64 * 1024;
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

export interface ProjectHttpContext {
  id: string;
  loaded: LoadedConfig;
  supervisor: RunSupervisor;
  strategies?: StrategyBlueprintCatalog;
}

export async function listenControlServer(
  loaded: LoadedConfig,
  supervisor: RunSupervisor,
  options: {
    host: string;
    port: number;
    staticDirectory?: string;
    strategyCatalog?: StrategyBlueprintCatalog;
    sessionToken?: string;
  },
): Promise<ListeningControlServer> {
  const context: ProjectHttpContext = {
    id: "default",
    loaded,
    supervisor,
    ...(options.strategyCatalog ? { strategies: options.strategyCatalog } : {}),
  };
  return await listenHttpServer(
    (request, response, staticDirectory) =>
      handleSingleProjectRequest(context, request, response, staticDirectory),
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
    (request, response, staticDirectory) =>
      handleWorkspaceRequest(projects, byId, request, response, staticDirectory),
    options,
  );
}

async function listenHttpServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    staticDirectory: string,
  ) => Promise<void>,
  options: HttpServerOptions,
): Promise<ListeningControlServer> {
  assertLoopbackHost(options.host);
  if (options.sessionToken && !desktopSessionTokenPattern.test(options.sessionToken)) {
    throw new Error("Desktop session token must contain 64 lowercase hexadecimal characters");
  }
  const staticDirectory = options.staticDirectory ?? bundledWebDirectory;
  const server = createServer((request, response) => {
    setSecurityHeaders(response);
    void Promise.resolve()
      .then(() => handleDesktopSession(request, response, options.sessionToken))
      .then(async (handled) => {
        if (!handled) await handler(request, response, staticDirectory);
      })
      .catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined);
          return;
        }
        const status = error instanceof HttpError ? error.status : 500;
        sendJson(response, status, {
          error: error instanceof Error ? error.message : String(error),
        });
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

async function handleSingleProjectRequest(
  context: ProjectHttpContext,
  request: IncomingMessage,
  response: ServerResponse,
  staticDirectory: string,
): Promise<void> {
  setSecurityHeaders(response);
  validateOrigin(request);
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/workspace") {
    sendJson(response, 200, workspaceProjection("single", [context]));
    return;
  }
  if (await dispatchProjectApi(context, request, response, url, "/api")) {
    return;
  }
  if ((method === "GET" || method === "HEAD") && !isApiPath(url.pathname)) {
    if (await serveWebAsset(response, url.pathname, staticDirectory, method === "HEAD")) {
      return;
    }
  }
  throw new HttpError(404, "Route not found");
}

async function handleWorkspaceRequest(
  projects: ProjectHttpContext[],
  byId: Map<string, ProjectHttpContext>,
  request: IncomingMessage,
  response: ServerResponse,
  staticDirectory: string,
): Promise<void> {
  setSecurityHeaders(response);
  validateOrigin(request);
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const method = request.method ?? "GET";

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
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/|$)/);
  if (match?.[1]) {
    const projectId = decodePathSegment(match[1]);
    const context = byId.get(projectId);
    if (!context) {
      throw new HttpError(404, "Project not found");
    }
    const apiRoot = `/api/projects/${match[1]}`;
    if (await dispatchProjectApi(context, request, response, url, apiRoot)) {
      return;
    }
  }
  if ((method === "GET" || method === "HEAD") && !isApiPath(url.pathname)) {
    if (await serveWebAsset(response, url.pathname, staticDirectory, method === "HEAD")) {
      return;
    }
  }
  throw new HttpError(404, "Route not found");
}

async function dispatchProjectApi(
  context: ProjectHttpContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  apiRoot: string,
): Promise<boolean> {
  if (url.pathname !== apiRoot && !url.pathname.startsWith(`${apiRoot}/`)) {
    return false;
  }
  const localPath = url.pathname.slice(apiRoot.length) || "/";
  const method = request.method ?? "GET";
  const { loaded, supervisor } = context;

  if (method === "GET" && localPath === "/health") {
    sendJson(response, 200, {
      status: "ok",
      project: loaded.config.project.name,
      projectId: context.id,
      supervisorId: supervisor.id,
    });
    return true;
  }
  if (method === "GET" && localPath === "/config") {
    sendJson(response, 200, buildPublicConfig(loaded, context.strategies));
    return true;
  }
  if (method === "POST" && localPath === "/strategies/preflight") {
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
      throw strategyHttpError(error);
    }
    return true;
  }
  const strategyMatch = localPath.match(/^\/strategies\/([^/]+)$/);
  if ((method === "PUT" || method === "DELETE") && strategyMatch?.[1]) {
    const name = decodePathSegment(strategyMatch[1]);
    const catalog = requireStrategyCatalog(context);
    try {
      if (method === "DELETE") {
        await catalog.delete(name);
        sendJson(response, 200, { name, deleted: true });
      } else {
        const parsed = strategyBlueprintRequestSchema.safeParse(await readJson(request));
        if (!parsed.success) {
          throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
        }
        const checked = await catalog.save(name, parsed.data.definition);
        sendJson(response, 200, blueprintProjection(checked, "custom"));
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw strategyHttpError(error);
    }
    return true;
  }
  if (method === "GET" && localPath === "/interop") {
    sendJson(response, 200, buildInteropManifest(loaded.config));
    return true;
  }
  if (method === "GET" && localPath === "/runs") {
    sendJson(response, 200, { runs: await supervisor.list() });
    return true;
  }
  if (method === "POST" && localPath === "/runs") {
    const parsed = startRunRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
    }
    const idempotency = singleHeader(request.headers["idempotency-key"]);
    const result = supervisor.start(parsed.data, idempotency);
    sendJson(response, result.deduplicated ? 200 : 202, result);
    return true;
  }
  if (method === "POST" && localPath === "/runs/cleanup/preview") {
    const parsed = cleanupPreviewRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
    }
    sendJson(response, 200, await supervisor.previewCleanup(parsed.data.olderThanDays));
    return true;
  }
  if (method === "POST" && localPath === "/runs/cleanup") {
    const parsed = cleanupRunRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
    }
    try {
      sendJson(response, 200, await supervisor.cleanup(parsed.data.token));
    } catch (error) {
      throw new HttpError(409, error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  if (method === "GET" && localPath === "/events") {
    streamEvents(request, response, supervisor, url.searchParams.get("runId") ?? undefined);
    return true;
  }

  const telemetryMatch = localPath.match(/^\/runs\/([^/]+)\/telemetry$/);
  if (method === "GET" && telemetryMatch?.[1]) {
    const runId = decodePathSegment(telemetryMatch[1]);
    if (!(await supervisor.get(runId))) {
      throw new HttpError(404, "Run not found");
    }
    sendJson(
      response,
      200,
      buildOtlpTraceExport(listRunEvents(supervisor, runId), loaded.config.project.name),
    );
    return true;
  }
  const evidenceFileMatch = localPath.match(/^\/runs\/([^/]+)\/evidence\/file$/);
  if (method === "GET" && evidenceFileMatch?.[1]) {
    const relativePath = url.searchParams.get("path");
    if (!relativePath) throw new HttpError(400, "Artifact path is required");
    const runId = decodePathSegment(evidenceFileMatch[1]);
    try {
      sendJson(response, 200, {
        file: await supervisor.evidenceFile(runId, relativePath),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(message.includes("was not found") ? 404 : 400, message);
    }
    return true;
  }
  const evidenceMatch = localPath.match(/^\/runs\/([^/]+)\/evidence$/);
  if (method === "GET" && evidenceMatch?.[1]) {
    const evidence = await supervisor.evidence(decodePathSegment(evidenceMatch[1]));
    if (!evidence) throw new HttpError(404, "Run not found");
    sendJson(response, 200, { evidence });
    return true;
  }

  const runMatch = localPath.match(/^\/runs\/([^/]+)$/);
  if (method === "GET" && runMatch?.[1]) {
    const run = await supervisor.get(decodePathSegment(runMatch[1]));
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    sendJson(response, 200, { run });
    return true;
  }
  const actionMatch = localPath.match(/^\/runs\/([^/]+)\/actions\/cancel$/);
  if (method === "POST" && actionMatch?.[1]) {
    const runId = decodePathSegment(actionMatch[1]);
    if (!supervisor.cancel(runId)) {
      throw new HttpError(409, "Run is not active in this control service");
    }
    sendJson(response, 202, { runId, status: "cancel-requested" });
    return true;
  }
  const retryMatch = localPath.match(/^\/runs\/([^/]+)\/actions\/retry$/);
  if (method === "POST" && retryMatch?.[1]) {
    const runId = decodePathSegment(retryMatch[1]);
    const idempotency = singleHeader(request.headers["idempotency-key"]);
    try {
      const result = await supervisor.retry(runId, idempotency);
      sendJson(response, result.deduplicated ? 200 : 202, result);
    } catch (error) {
      throw new HttpError(409, error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  const approvalMatch = localPath.match(/^\/runs\/([^/]+)\/actions\/respond-approval$/);
  if (method === "POST" && approvalMatch?.[1]) {
    const parsed = approvalResponseRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
    }
    try {
      const result = await supervisor.respondApproval(
        decodePathSegment(approvalMatch[1]),
        parsed.data,
      );
      sendJson(response, result.status === "resuming" ? 202 : 200, result);
    } catch (error) {
      throw new HttpError(409, error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  const resumeMatch = localPath.match(/^\/runs\/([^/]+)\/actions\/resume$/);
  if (method === "POST" && resumeMatch?.[1]) {
    const parsed = resumeRunRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
    }
    try {
      const result = await supervisor.resume(decodePathSegment(resumeMatch[1]), parsed.data);
      sendJson(response, 202, result);
    } catch (error) {
      throw new HttpError(409, error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  return false;
}

function listRunEvents(supervisor: RunSupervisor, runId: string): RunEvent[] {
  const collected: RunEvent[] = [];
  let cursor = 0;
  while (true) {
    const page = supervisor.events.listAfter(cursor, runId, 10_000);
    collected.push(...page);
    if (page.length < 10_000) return collected;
    cursor = page.at(-1)!.sequence;
  }
}

function streamEvents(
  request: IncomingMessage,
  response: ServerResponse,
  supervisor: RunSupervisor,
  runId?: string,
): void {
  const headerCursor = singleHeader(request.headers["last-event-id"]);
  const url = new URL(request.url ?? "/", "http://localhost");
  const cursorText = url.searchParams.get("after") ?? headerCursor ?? "0";
  const cursor = Number(cursorText);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new HttpError(400, "Event cursor must be a non-negative integer");
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write("retry: 2000\n\n");
  const write = (event: RunEvent): void => {
    if (!runId || event.runId === runId) {
      response.write(`id: ${event.sequence}\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };
  let replayCursor = cursor;
  while (true) {
    const events = supervisor.events.listAfter(replayCursor, runId, 1_000);
    for (const event of events) {
      write(event);
      replayCursor = event.sequence;
    }
    if (events.length < 1_000) {
      break;
    }
  }
  const unsubscribe = supervisor.events.subscribe(write);
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  heartbeat.unref();
  request.once("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > maxBodyBytes) {
      throw new HttpError(413, "Request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

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
            executionTimeoutSeconds: 14_400,
            maxAgentInvocations: 64,
            maxProcessOutputBytes: 1_048_576,
            maxArtifactBytes: 1_073_741_824,
            roleProfiles: {},
            approvalGates: ["final"],
            approvalTimeoutSeconds: 86_400,
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
    interop: buildInteropManifest(loaded.config),
  };
}

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
  if (error instanceof StrategyBlueprintConflictError) return new HttpError(409, message);
  if (error instanceof StrategyBlueprintNotFoundError) return new HttpError(404, message);
  return new HttpError(400, message);
}

function workspaceProjection(
  mode: "single" | "workspace",
  projects: ProjectHttpContext[],
): unknown {
  return {
    mode,
    defaultProjectId: projects[0]!.id,
    projects: projects.map((project) => ({
      id: project.id,
      name: project.loaded.config.project.name,
      defaultBranch: project.loaded.config.project.defaultBranch,
    })),
  };
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "Invalid URL path");
  }
}

function validateOrigin(request: IncomingMessage): void {
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
  if (originUrl.host !== request.headers.host || originUrl.protocol !== "http:") {
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

async function serveWebAsset(
  response: ServerResponse,
  pathname: string,
  staticDirectory: string,
  headOnly: boolean,
): Promise<boolean> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "Invalid URL path");
  }
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  let candidate = path.resolve(staticDirectory, relativePath);
  const rootPrefix = `${path.resolve(staticDirectory)}${path.sep}`;
  if (!candidate.startsWith(rootPrefix)) {
    throw new HttpError(404, "Route not found");
  }
  let contents = await readFile(candidate).catch(() => undefined);
  if (!contents && !path.extname(relativePath)) {
    candidate = path.join(staticDirectory, "index.html");
    contents = await readFile(candidate).catch(() => undefined);
  }
  if (!contents) {
    return false;
  }
  response.writeHead(200, {
    "Content-Type": contentType(candidate),
    "Content-Length": contents.byteLength,
    "Cache-Control": relativePath.startsWith("assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  });
  response.end(headOnly ? undefined : contents);
  return true;
}

function contentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  }[extension] ?? "application/octet-stream";
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const serialized = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(serialized),
    "Cache-Control": "no-store",
  });
  response.end(serialized);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function assertLoopbackHost(host: string): void {
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(`Control service must bind to a loopback host, received '${host}'`);
  }
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const bundledWebDirectory = fileURLToPath(new URL("../../web/dist", import.meta.url));
