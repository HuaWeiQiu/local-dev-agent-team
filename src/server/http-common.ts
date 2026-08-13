import type { IncomingMessage, ServerResponse } from "node:http";
import type { LoadedConfig } from "../config/load.js";
import type { StrategyBlueprintCatalog } from "../strategies/catalog.js";
import type { EvolutionProjectService } from "./evolution-service.js";
import type { RunSupervisor } from "./supervisor.js";

export const maxBodyBytes = 64 * 1024;

export interface ProjectHttpContext {
  id: string;
  loaded: LoadedConfig;
  supervisor: RunSupervisor;
  strategies?: StrategyBlueprintCatalog;
  evolution?: EvolutionProjectService;
}

export type ProjectApiHandler = (
  context: ProjectHttpContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  params: Record<string, string>,
  serverOrigin: string,
  sessionOperator: string | undefined,
) => Promise<void> | void;

export interface ProjectApiRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  pattern: string;
  handler: ProjectApiHandler;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const serialized = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(serialized),
    "Cache-Control": "no-store",
  });
  response.end(serialized);
}

export function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function readJson(
  request: IncomingMessage,
  limit = maxBodyBytes,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limit) {
      throw new HttpError(413, "Request body is too large", "REQUEST_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON", "INVALID_REQUEST");
  }
}

export function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "Invalid URL path");
  }
}

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function invalidRequest(messages: string[]): HttpError {
  return new HttpError(400, messages.join("; "), "INVALID_REQUEST");
}

const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function invalidIdempotencyKey(): HttpError {
  return new HttpError(
    400,
    "Idempotency-Key must contain 1-128 safe identifier characters",
    "INVALID_IDEMPOTENCY_KEY",
  );
}

export function optionalIdempotencyKey(request: IncomingMessage): string | undefined {
  const value = singleHeader(request.headers["idempotency-key"]);
  if (value === undefined) {
    return undefined;
  }
  if (!idempotencyKeyPattern.test(value)) {
    throw invalidIdempotencyKey();
  }
  return value;
}

export function requireIdempotencyKey(request: IncomingMessage): string {
  const value = optionalIdempotencyKey(request);
  if (!value) {
    throw invalidIdempotencyKey();
  }
  return value;
}

export function requireEvolutionSession(sessionOperator: string | undefined): string {
  if (!sessionOperator) {
    throw new HttpError(401, "A local control session is required", "SESSION_REQUIRED");
  }
  return sessionOperator;
}
