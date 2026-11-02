// @vitest-environment jsdom
import "./web/dom-setup.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatRelative } from "../web/src/time.js";
import { getInitialTheme } from "../web/src/theme.js";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");

describe("formatRelative", () => {
  it("returns nothing for a timestamp it cannot parse", () => {
    expect(formatRelative("not a date", NOW)).toBe("");
  });

  it("says 刚刚 under a minute in either direction", () => {
    expect(formatRelative(new Date(NOW - 30_000).toISOString(), NOW)).toBe("刚刚");
    expect(formatRelative(new Date(NOW + 30_000).toISOString(), NOW)).toBe("刚刚");
  });

  it("picks the largest unit that fits", () => {
    expect(formatRelative(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toMatch(/5/);
    expect(formatRelative(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toMatch(/3/);
  });

  it("falls back to 刚刚 when no unit fits", () => {
    const unitless = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      expect(formatRelative(new Date(NOW).toISOString(), NOW)).toBe("刚刚");
    } finally {
      unitless.mockRestore();
    }
  });
});

describe("getInitialTheme", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    // jsdom in this setup ships no Storage, so the hook gets a Map-backed one.
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
        clear: () => store.clear(),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["light", "dark", "system"] as const)("reads the stored %s theme", (mode) => {
    window.localStorage.setItem("agent-team-theme", mode);

    expect(getInitialTheme()).toBe(mode);
  });

  it("ignores a stored value it does not know", () => {
    window.localStorage.setItem("agent-team-theme", "neon");

    expect(getInitialTheme()).toBe("system");
  });

  it("follows the system when localStorage is unavailable", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });

    expect(getInitialTheme()).toBe("system");
  });
});
