import { describe, expect, it } from "vitest";
import {
  LayerError,
  assertCapability,
  can,
  sharedCapabilities,
  surfaceOf,
  type Capability,
} from "../src/runtime/roles.js";

describe("the layer split", () => {
  it("gives the router coordination and speech, never execution", () => {
    expect(surfaceOf("router")).toEqual(["admit", "dispatch", "speak"]);
    expect(can("router", "execute")).toBe(false);
    expect(can("router", "quality")).toBe(false);
    expect(can("router", "publish")).toBe(false);
  });

  it("gives the worker execution and reporting, never admission", () => {
    expect(surfaceOf("worker")).toEqual(["plan", "execute", "quality", "publish"]);
    expect(can("worker", "admit")).toBe(false);
    expect(can("worker", "dispatch")).toBe(false);
    // A worker does not speak to a person; it reports, and the router speaks.
    expect(can("worker", "speak")).toBe(false);
  });

  it("gives each capability to exactly one layer", () => {
    expect(sharedCapabilities()).toEqual([]);
  });

  it("covers every capability, so nothing is silently unowned", () => {
    const all: Capability[] = ["admit", "dispatch", "speak", "plan", "execute", "quality", "publish"];
    const owned = new Set([...surfaceOf("router"), ...surfaceOf("worker")]);
    expect([...owned].sort()).toEqual([...all].sort());
  });
});

describe("assertCapability", () => {
  it("passes for a capability the layer holds", () => {
    expect(() => assertCapability("router", "admit")).not.toThrow();
    expect(() => assertCapability("worker", "execute")).not.toThrow();
  });

  it("refuses with the layer and the capability named", () => {
    expect(() => assertCapability("router", "execute")).toThrow(LayerError);
    try {
      assertCapability("router", "execute");
    } catch (error) {
      expect(error).toMatchObject({ layer: "router", capability: "execute" });
      expect(String(error)).toContain("must not execute");
    }
  });
});

