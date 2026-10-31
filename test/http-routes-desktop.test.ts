import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchDesktopApi, requireDesktopMutation } from "../src/server/http-routes-desktop.js";
import { HttpError } from "../src/server/http-common.js";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Minimal request/response doubles: the dispatcher only reads headers and writes JSON. */
async function* bodyStream(body: string): AsyncGenerator<Buffer> {
  if (body) yield Buffer.from(body);
}

function request(headers: Record<string, string> = {}, body = ""): IncomingMessage {
  const stream = {
    headers,
    ...(body ? { [Symbol.asyncIterator]: () => bodyStream(body) } : {}),
  };
  return stream as unknown as IncomingMessage;
}

function response(): ServerResponse & { status?: number; payload?: unknown } {
  const res = {
    status: undefined as number | undefined,
    payload: undefined as unknown,
    headersSent: false,
    setHeader() {
      return res;
    },
    writeHead(status: number) {
      res.status = status;
      return res;
    },
    end(chunk?: string) {
      if (chunk) res.payload = JSON.parse(chunk);
      return res;
    },
  };
  return res as unknown as ServerResponse & { status?: number; payload?: unknown };
}

const homes: string[] = [];

beforeEach(() => {
  // Keep the settings file inside a temp home so tests never touch the real one.
  const home = home_();
  homes.push(home);
});

function home_(): string {
  const dir = path.join(tmpdir(), `agent-team-desktop-route-${Math.random().toString(36).slice(2, 8)}`);
  homes.push(dir);
  process.env.AGENT_TEAM_HOME = dir;
  return dir;
}

afterEach(async () => {
  await Promise.allSettled(homes.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

describe("dispatchDesktopApi", () => {
  it("ignores non-desktop paths", async () => {
    const handled = await dispatchDesktopApi(
      request(),
      response(),
      new URL("http://127.0.0.1/api/runs"),
      "GET",
      "http://127.0.0.1",
      undefined,
    );
    expect(handled).toBe(false);
  });

  it("serves the CLI inventory with and without a refresh", async () => {
    const res = response();
    const handled = await dispatchDesktopApi(
      request(),
      res,
      new URL("http://127.0.0.1/api/desktop/cli-inventory?refresh=1"),
      "GET",
      "http://127.0.0.1",
      undefined,
    );
    expect(handled).toBe(true);
    expect(res.status).toBe(200);
    expect(res.payload).toHaveProperty("inventory");
  });

  it("serves and updates the desktop settings", async () => {
    const read = response();
    await dispatchDesktopApi(
      request(),
      read,
      new URL("http://127.0.0.1/api/desktop/settings"),
      "GET",
      "http://127.0.0.1",
      undefined,
    );
    expect(read.payload).toHaveProperty("settings");
    expect(read.payload).toHaveProperty("suggestedDefaults");

    const body = JSON.stringify({
      defaults: { roles: {} },
      ui: { showCliPickerInRunLauncher: true, autoDetectCliConfig: true, autoDetectOnFocus: true },
    });
    const write = response();
    await dispatchDesktopApi(
      request({ origin: "http://127.0.0.1", "content-type": "application/json" }, body),
      write,
      new URL("http://127.0.0.1/api/desktop/settings"),
      "PUT",
      "http://127.0.0.1",
      "operator",
    );
    expect(write.status).toBe(200);
  });

  it("404s an unknown desktop route", async () => {
    await expect(
      dispatchDesktopApi(
        request(),
        response(),
        new URL("http://127.0.0.1/api/desktop/unknown"),
        "GET",
        "http://127.0.0.1",
        undefined,
      ),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("requires the exact origin for a desktop mutation", async () => {
    await expect(
      dispatchDesktopApi(
        request({ origin: "http://evil.test" }),
        response(),
        new URL("http://127.0.0.1/api/desktop/cli-inventory/scan"),
        "POST",
        "http://127.0.0.1",
        undefined,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("requireDesktopMutation", () => {
  it("returns the operator when the origin matches", () => {
    expect(requireDesktopMutation(request({ origin: "http://127.0.0.1" }), "http://127.0.0.1", "op")).toBe("op");
  });

  it("allows a local request without an origin", () => {
    expect(requireDesktopMutation(request(), "http://127.0.0.1", undefined)).toBe("local-dev");
  });

  it("rejects a foreign origin", () => {
    expect(() =>
      requireDesktopMutation(request({ origin: "http://evil.test" }), "http://127.0.0.1", undefined),
    ).toThrow(/exact local origin/);
  });
});
