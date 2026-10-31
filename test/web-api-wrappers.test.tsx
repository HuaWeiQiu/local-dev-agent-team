// @vitest-environment jsdom
import "./web/dom-setup.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadRunEvents,
  getTicketAttention,
  promoteExperience,
  retrieveExperience,
  saveDesktopSettings,
} from "../web/src/api.js";

const scope = { mode: "single", projectId: "p1" } as never;
const projectScope = { mode: "workspace", projectId: "p1" } as never;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    blob: async () => new Blob([""]),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({}));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function lastCall(): [string, RequestInit | undefined] {
  return fetchMock.mock.calls.at(-1) as [string, RequestInit | undefined];
}

describe("experience wrappers", () => {
  it("retrieves with a query and a preview flag", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ hints: [] }));
    await retrieveExperience(scope, " flaky ", { preview: true });
    expect(lastCall()[0]).toContain("/experience/retrieve?q=flaky&preview=1");
    expect(lastCall()[1]).toMatchObject({ cache: "no-store" });
  });

  it("retrieves without a query at all", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ hints: [] }));
    await retrieveExperience(scope);
    expect(lastCall()[0]).toMatch(/\/experience\/retrieve$/);
  });

  it("promotes with every optional field it was given", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "e1" }));
    await promoteExperience(scope, "e1", "because", {
      actor: "alice",
      suiteDigest: "d1",
      forceWithoutSuite: true,
    });
    const body = JSON.parse(String(lastCall()[1]!.body));
    expect(body).toEqual({
      reason: "because",
      actor: "alice",
      suiteDigest: "d1",
      forceWithoutSuite: true,
    });
  });

  it("promotes with only the reason", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "e1" }));
    await promoteExperience(scope, "e1", "because");
    expect(JSON.parse(String(lastCall()[1]!.body))).toEqual({ reason: "because" });
  });
});

describe("desktop settings", () => {
  it("sends the defaults and the ui switches", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ settings: {} }));
    await saveDesktopSettings({
      defaults: { roles: {} },
      ui: { showCliPickerInRunLauncher: true, autoDetectCliConfig: false, autoDetectOnFocus: true },
    } as never);
    expect(lastCall()[0]).toBe("/api/desktop/settings");
    expect(lastCall()[1]).toMatchObject({ method: "PUT" });
  });
});

describe("ticket attention", () => {
  it("reads the queue from the project's route", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ attention: [], working: 0, total: 0 }));
    await expect(getTicketAttention(projectScope)).resolves.toEqual({
      attention: [],
      working: 0,
      total: 0,
    });
    expect(lastCall()[0]).toContain("/projects/p1/tickets");
  });
});

describe("downloadRunEvents", () => {
  it("clicks a temporary link and revokes it afterwards", async () => {
    const click = vi.fn();
    const remove = vi.fn();
    vi.spyOn(document, "createElement").mockReturnValue({
      set href(_value: string) {},
      set download(_value: string) {},
      click,
      remove,
    } as never);
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:x",
      revokeObjectURL: vi.fn(),
    });
    const timeout = vi.spyOn(window, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as never);

    await downloadRunEvents(scope, "run-1");
    expect(click).toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
    expect(timeout).toHaveBeenCalled();
  });

  it("surfaces the server's error", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "gone", code: "NOT_FOUND" }, 404));
    await expect(downloadRunEvents(scope, "run-1")).rejects.toMatchObject({
      status: 404,
      message: "gone",
      code: "NOT_FOUND",
    });
  });
});
