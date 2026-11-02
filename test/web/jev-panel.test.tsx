// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `JevPanel` is rendered through the settings workbench, where its branches were
 * covered by whatever happened to finish before the test ended — the component's
 * CRAP swung between runs for exactly that reason. Rendering it directly and
 * asserting each branch is what makes its coverage a property of the tests.
 */
const api = vi.hoisted(() => ({
  getConfig: vi.fn(),
  probeJev: vi.fn(),
}));

vi.mock("../../web/src/api", async () => {
  const actual = await vi.importActual<typeof import("../../web/src/api")>(
    "../../web/src/api",
  );
  return { ...actual, ...api };
});

const { JevPanel } = await import("../../web/src/components/JevPanel.js");

const scope = { id: "p1", name: "demo", root: "/repo" };

const enabled = {
  jev: {
    enabled: true,
    baseUrl: "http://127.0.0.1:8317/v1",
    protocol: "openai",
    model: "jev-local",
    timeoutMs: 20_000,
    minConfidence: 0.8,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("JevPanel", () => {
  it("shows the resolved settings and the probe result", async () => {
    api.getConfig.mockResolvedValue(enabled);
    api.probeJev.mockResolvedValue({
      ok: true,
      latencyMs: 12,
      decision: { decision: "consult", confidence: 0.91, reason: "" },
    });
    render(<JevPanel scope={scope} />);

    expect(await screen.findByText("http://127.0.0.1:8317/v1")).toBeVisible();
    expect(screen.getByText("jev-local")).toBeVisible();
    expect(screen.getByText("已启用")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /测试连接/ }));
    expect(await screen.findByText(/连接正常（12 ms）：模拟失败 → 升级给顾问/)).toBeVisible();
  });

  it("shows the failure the probe returned", async () => {
    api.getConfig.mockResolvedValue(enabled);
    api.probeJev.mockRejectedValue(new Error("connect ECONNREFUSED"));
    render(<JevPanel scope={scope} />);
    await screen.findByText("jev-local");

    await userEvent.click(screen.getByRole("button", { name: /测试连接/ }));
    expect(await screen.findByText("connect ECONNREFUSED")).toBeVisible();
  });

  it("explains how to configure a project that has no jev block", async () => {
    api.getConfig.mockResolvedValue({ jev: null });
    render(<JevPanel scope={scope} />);

    expect(await screen.findByText(/没有 jev 配置/)).toBeVisible();
    expect(screen.getByText(/baseUrl: http:\/\/127\.0\.0\.1/)).toBeVisible();
    expect(screen.getByText("未配置")).toBeVisible();
  });

  it("surfaces a config read error instead of an empty panel", async () => {
    api.getConfig.mockRejectedValue(new Error("config unreadable"));
    render(<JevPanel scope={scope} />);

    expect(await screen.findByText("config unreadable")).toBeVisible();
  });
});
