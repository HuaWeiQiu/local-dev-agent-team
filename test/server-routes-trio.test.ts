import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { LoadedConfig } from "../src/config/load.js";
import {
  StrategyBlueprintConflictError,
  StrategyBlueprintNotFoundError,
} from "../src/strategies/catalog.js";
import type { ProjectHttpContext } from "../src/server/http-common.js";
import { ProjectMutationConflictError } from "../src/server/supervisor.js";

const detect = vi.hoisted(() => ({ detectRepository: vi.fn() }));
const inventory = vi.hoisted(() => ({ getInventory: vi.fn() }));

vi.mock("../src/onboarding/detect.js", async () => {
  const actual = await vi.importActual<typeof import("../src/onboarding/detect.js")>(
    "../src/onboarding/detect.js",
  );
  return { ...actual, ...detect };
});

vi.mock("../src/desktop/settings.js", async () => {
  const actual = await vi.importActual<typeof import("../src/desktop/settings.js")>(
    "../src/desktop/settings.js",
  );
  return { ...actual, ...inventory };
});

const { onboardingRoutes } = await import("../src/server/http-routes-onboarding.js");
const { strategyRoutes } = await import("../src/server/http-routes-strategies.js");

function request(body?: unknown): IncomingMessage {
  const emitter = new EventEmitter() as unknown as IncomingMessage & EventEmitter;
  // readJson consumes the request with for-await, so the fake has to be async iterable.
  (emitter as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = async function* () {
    if (body !== undefined) {
      yield Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    }
  };
  return emitter;
}

function response() {
  let status = 0;
  let payload = "";
  const res = {
    writeHead: (code: number) => {
      status = code;
      return res;
    },
    write: () => true,
    end: (chunk?: string) => {
      if (chunk) payload += chunk;
      return res;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    status: () => status,
    body: () => (payload ? JSON.parse(payload) : undefined),
  };
}

function loaded(patch: Record<string, unknown> = {}): LoadedConfig {
  return {
    root: "/tmp/project",
    path: "/tmp/project/agent-team.yaml",
    source: "file",
    config: {
      project: { name: "Project", stateDirectory: ".agent-team" },
      quality: { commands: [{ command: "pnpm", args: ["test"] }] },
    },
    ...patch,
  } as unknown as LoadedConfig;
}

function context(extra: Partial<ProjectHttpContext> = {}): ProjectHttpContext {
  return { id: "project-1", loaded: loaded(), ...extra } as ProjectHttpContext;
}

function route(routes: Array<{ method: string; pattern: string; handler: unknown }>, method: string) {
  const found = routes.find((entry) => entry.method === method);
  if (!found) throw new Error(`no ${method} route`);
  return found.handler as (
    context: ProjectHttpContext,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    params: Record<string, string>,
  ) => Promise<void>;
}

describe("onboarding status", () => {
  it("reports detection, quality commands and the recommended CLI", async () => {
    detect.detectRepository.mockResolvedValue({ stacks: ["node"] });
    inventory.getInventory.mockResolvedValue({
      inventory: {
        clis: [
          {
            id: "codex",
            installed: true,
            runtimeSupported: true,
            version: "1.2.3",
            auth: { status: "ready" },
          },
          {
            id: "grok",
            installed: false,
            runtimeSupported: true,
            auth: { status: "missing" },
          },
        ],
      },
    });
    const out = response();

    await route(onboardingRoutes, "GET")(
      context(),
      request(),
      out.res,
      new URL("http://localhost/onboarding"),
      {},
    );

    expect(out.status()).toBe(200);
    expect(out.body()).toMatchObject({
      projectId: "project-1",
      projectName: "Project",
      source: "file",
      needsSetup: false,
      detection: { stacks: ["node"] },
      current: { commands: [{ command: "pnpm", args: ["test"] }] },
    });
    expect(out.body().clis[0]).toMatchObject({ id: "codex", version: "1.2.3" });
    expect(out.body().clis[1]).not.toHaveProperty("version");
  });

  it("survives an inventory probe that fails and still answers", async () => {
    detect.detectRepository.mockResolvedValue({ stacks: [] });
    inventory.getInventory.mockRejectedValue(new Error("no desktop session"));
    const out = response();

    await route(onboardingRoutes, "GET")(
      context({ loaded: loaded({ source: "detected" }) }),
      request(),
      out.res,
      new URL("http://localhost/onboarding"),
      {},
    );

    expect(out.status()).toBe(200);
    expect(out.body()).toMatchObject({ needsSetup: true, clis: [] });
    expect(out.body()).not.toHaveProperty("recommendedCli");
  });
});

describe("strategy error mapping", () => {
  const conflictCatalog = {
    save: vi.fn().mockRejectedValue(new StrategyBlueprintConflictError("已存在")),
  };
  const missingCatalog = {
    save: vi.fn().mockRejectedValue(new StrategyBlueprintNotFoundError("没有")),
  };

  it("maps a blueprint conflict to 409", async () => {
    await expect(
      route(strategyRoutes, "PUT")(
        context({ strategies: conflictCatalog as never }),
        request({ definition: {} }),
        response().res,
        new URL("http://localhost/strategies/x"),
        { name: "x" },
      ),
    ).rejects.toMatchObject({ status: 409, message: "已存在" });
  });

  it("maps a missing blueprint to 404", async () => {
    await expect(
      route(strategyRoutes, "PUT")(
        context({ strategies: missingCatalog as never }),
        request({ definition: {} }),
        response().res,
        new URL("http://localhost/strategies/x"),
        { name: "x" },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("maps a project mutation conflict to 409 with its code", async () => {
    const catalog = {
      save: vi.fn().mockRejectedValue(new ProjectMutationConflictError("别的写入")),
    };

    await expect(
      route(strategyRoutes, "PUT")(
        context({ strategies: catalog as never }),
        request({ definition: {} }),
        response().res,
        new URL("http://localhost/strategies/x"),
        { name: "x" },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("maps anything else to 400", async () => {
    const catalog = { save: vi.fn().mockRejectedValue(new Error("随便什么错")) };

    await expect(
      route(strategyRoutes, "PUT")(
        context({ strategies: catalog as never }),
        request({ definition: {} }),
        response().res,
        new URL("http://localhost/strategies/x"),
        { name: "x" },
      ),
    ).rejects.toMatchObject({ status: 400, message: "随便什么错" });
  });

  it("passes an HttpError through untouched", async () => {
    const catalog = { save: vi.fn() };

    await expect(
      route(strategyRoutes, "PUT")(
        context({ strategies: catalog as never }),
        request({ notADefinition: true }),
        response().res,
        new URL("http://localhost/strategies/x"),
        { name: "x" },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
