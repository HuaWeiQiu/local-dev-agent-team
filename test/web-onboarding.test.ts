// @vitest-environment jsdom
import "./web/dom-setup.js";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dismissKey,
  markDismissed,
  readDismissed,
  saveQuality,
  shouldOpenWizard,
  useOnboarding,
} from "../web/src/hooks/useOnboarding.js";
import type { OnboardingStatus, ProjectScope } from "../web/src/types.js";

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return { ...actual, getOnboarding: vi.fn(), saveOnboardingQuality: vi.fn() };
});

const scope = { mode: "single", projectId: "p1" } as ProjectScope;

/** jsdom in this setup has no storage: install a Map-backed one per test. */
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  });
});

function status(patch: Partial<OnboardingStatus> = {}): OnboardingStatus {
  return { needsSetup: true, ...patch } as OnboardingStatus;
}

describe("onboarding dismissal", () => {
  it("keys per project and mode", () => {
    expect(dismissKey(scope)).toBe("agent-team:onboarding-dismissed:single:p1");
    expect(dismissKey({ mode: "multi", projectId: "p2" } as ProjectScope)).toContain("multi:p2");
  });

  it("remembers a dismissal and reads it back", () => {
    expect(readDismissed(scope)).toBe(false);
    markDismissed(scope);
    expect(readDismissed(scope)).toBe(true);
  });

  it("survives storage that throws", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("denied");
      },
      getItem: () => {
        throw new Error("denied");
      },
    });
    expect(() => markDismissed(scope)).not.toThrow();
    expect(readDismissed(scope)).toBe(false);
  });
});

describe("shouldOpenWizard", () => {
  it("opens only for a needs-setup project that was not dismissed", () => {
    expect(shouldOpenWizard(scope, status())).toBe(true);
    expect(shouldOpenWizard(scope, status({ needsSetup: false }))).toBe(false);
    expect(shouldOpenWizard(undefined, status())).toBe(false);
    markDismissed(scope);
    expect(shouldOpenWizard(scope, status())).toBe(false);
  });
});

describe("saveQuality", () => {
  it("returns the new status on success", async () => {
    const api = await import("../web/src/api.js");
    (api.saveOnboardingQuality as ReturnType<typeof vi.fn>).mockResolvedValue({ needsSetup: false });
    await expect(saveQuality(scope, [{ command: "pnpm", args: ["test"] }])).resolves.toEqual({
      status: { needsSetup: false },
    });
  });

  it("returns the copy to show on failure", async () => {
    const api = await import("../web/src/api.js");
    (api.saveOnboardingQuality as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Run 'r1' was not found"),
    );
    const result = await saveQuality(scope, []);
    expect("error" in result && result.error).toContain("不存在");
  });
});

describe("useOnboarding", () => {
  async function loaded(patch: Record<string, unknown> = {}) {
    const api = await import("../web/src/api.js");
    (api.getOnboarding as ReturnType<typeof vi.fn>).mockResolvedValue({
      needsSetup: true,
      ...patch,
    });
    return renderHook(() => useOnboarding(scope));
  }

  it("opens the wizard when the project needs setup", async () => {
    const { result } = await loaded();
    await waitFor(() => expect(result.current.open).toBe(true));
    expect(result.current.status).toMatchObject({ needsSetup: true });
  });

  it("stays closed for a configured project", async () => {
    const { result } = await loaded({ needsSetup: false });
    await waitFor(() => expect(result.current.status).toBeDefined());
    expect(result.current.open).toBe(false);
  });

  it("swallows a failing status read", async () => {
    const api = await import("../web/src/api.js");
    (api.getOnboarding as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("nope"));
    const { result } = renderHook(() => useOnboarding(scope));
    await waitFor(() => expect(result.current.status).toBeUndefined());
    expect(result.current.open).toBe(false);
  });

  it("remembers a skip", async () => {
    const { result } = await loaded();
    await waitFor(() => expect(result.current.open).toBe(true));
    act(() => result.current.skip());
    expect(result.current.open).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(readDismissed(scope)).toBe(true);
  });

  it("saves quality commands and closes on success", async () => {
    const api = await import("../web/src/api.js");
    (api.saveOnboardingQuality as ReturnType<typeof vi.fn>).mockResolvedValue({ needsSetup: false });
    const { result } = await loaded();
    await waitFor(() => expect(result.current.open).toBe(true));
    await act(async () => {
      await expect(result.current.save([{ command: "pnpm", args: ["test"] }])).resolves.toBe(true);
    });
    expect(result.current.open).toBe(false);
  });

  it("shows the error copy and stays open on failure", async () => {
    const api = await import("../web/src/api.js");
    (api.saveOnboardingQuality as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Run 'r1' was not found"),
    );
    const { result } = await loaded();
    await waitFor(() => expect(result.current.open).toBe(true));
    await act(async () => {
      await expect(result.current.save([])).resolves.toBe(false);
    });
    expect(result.current.error).toContain("不存在");
  });

  it("reopens after skipping", async () => {
    const { result } = await loaded();
    await waitFor(() => expect(result.current.open).toBe(true));
    act(() => result.current.skip());
    act(() => result.current.reopen());
    expect(result.current.open).toBe(true);
    expect(result.current.error).toBeUndefined();
  });
});
