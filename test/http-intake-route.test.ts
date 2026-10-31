import { describe, expect, it } from "vitest";
import { intakeRoutes } from "../src/server/http-routes-intake.js";

const route = intakeRoutes[0]!;

function context(intakeEnabled: boolean) {
  const calls: unknown[] = [];
  return {
    calls,
    supervisor: {
      intakeEnabled,
      admitEvent: async (input: unknown) => {
        calls.push(input);
        return { admitted: [], refused: [], dropped: [] };
      },
    },
  } as never;
}

function response() {
  const written: Array<[number, unknown]> = [];
  return {
    written,
    res: { statusCode: 200 } as never,
  };
}

describe("intake route", () => {
  it("is a POST on /intake/github", () => {
    expect(route).toMatchObject({ method: "POST", pattern: "/intake/github" });
  });

  it("refuses everything while intake is off", async () => {
    const ctx = context(false);
    await expect(
      route.handler(ctx, {} as never, response().res, new URL("http://x/intake/github"), "/api", "http://x", undefined),
    ).rejects.toMatchObject({ status: 409, code: "INTAKE_DISABLED" });
    expect((ctx as never as { calls: unknown[] }).calls).toEqual([]);
  });
});

describe("intake route with intake on", () => {
  function requestBody(body: unknown) {
    return {
      headers: { "content-type": "application/json" },
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(JSON.stringify(body));
      },
    } as never;
  }

  it("hands the event to the supervisor and answers 202", async () => {
    const ctx = context(true) as unknown as { supervisor: { intakeEnabled: boolean } };
    const res = { statusCode: 0, setHeader: () => res, writeHead: (s: number) => ((res.statusCode = s), res), end: () => res } as never;
    await route.handler(
      ctx as never,
      requestBody({ event: "issue_comment", payload: { repository: { full_name: "a/b" } } }),
      res,
      new URL("http://x/intake/github"),
      "/api",
      "http://x",
      undefined,
    );
    expect((ctx as never as { calls: unknown[] }).calls).toHaveLength(1);
  });

  it("rejects a body without an event", async () => {
    const ctx = context(true);
    await expect(
      route.handler(
        ctx,
        requestBody({ payload: {} }),
        { statusCode: 0, setHeader: () => undefined, writeHead: () => undefined, end: () => undefined } as never,
        new URL("http://x/intake/github"),
        "/api",
        "http://x",
        undefined,
      ),
    ).rejects.toThrow();
  });
});
