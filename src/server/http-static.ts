import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { HttpError } from "./http-common.js";

export async function serveWebAsset(
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
