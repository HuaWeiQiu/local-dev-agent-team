// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliInventory, PublicConfig, StartRunInput } from "../../web/src/types.js";

const api = vi.hoisted(() => ({
  retrieveExperience: vi.fn(),
}));

vi.mock("../../web/src/api", async () => {
  const actual = await vi.importActual<typeof import("../../web/src/api")>(
    "../../web/src/api",
  );
  return { ...actual, ...api };
});

const { RunLauncher } = await import("../../web/src/components/RunLauncher.js");
const { RoleBindingGrid } = await import(
  "../../web/src/components/run-launcher/sections.js"
);

function config(): PublicConfig {
  return {
    project: { name: "demo", maxParallel: 2 },
    roles: {
      worker: { defaultProfile: "p1", allowedProfiles: ["p1"] },
      reviewer: { defaultProfile: "p2", allowedProfiles: ["p2"] },
    },
    strategies: {
      default: "demo",
      definitions: {
        demo: { roleProfiles: { worker: "p1" } },
        tighten: { roleProfiles: { worker: "p1", reviewer: "p2" } },
      },
    },
  } as unknown as PublicConfig;
}

function inventory(): CliInventory {
  return {
    scannedAt: "2026-10-30T00:00:00.000Z",
    home: "/h",
    clis: [
      {
        id: "kimi",
        installed: true,
        auth: { status: "present" },
        configPaths: [],
        models: [{ id: "m1", label: "m1", reasoningOptions: ["low", "high"] }],
        defaultModel: "m1",
        defaultReasoning: "high",
        runtimeSupported: true,
      },
    ],
  };
}

const scope = { id: "p1", name: "demo", root: "/repo" };

beforeEach(() => {
  vi.clearAllMocks();
  api.retrieveExperience.mockResolvedValue(undefined);
});

describe("RunLauncher", () => {
  it("submits the goal, strategy and per-role bindings", async () => {
    const onSubmit = vi.fn<(input: StartRunInput) => Promise<boolean>>().mockResolvedValue(true);
    render(
      <RunLauncher
        open
        config={config()}
        scope={scope}
        busy={false}
        error={undefined}
        inventory={inventory()}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    await userEvent.type(screen.getByLabelText("目标"), "T1 add a refund endpoint");
    await userEvent.click(screen.getByRole("button", { name: /启动运行/ }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      goal: "T1 add a refund endpoint",
      strategy: "demo",
      roleBindings: {
        worker: { cli: "kimi", model: "m1", reasoning: "high" },
        reviewer: { cli: "kimi", model: "m1", reasoning: "high" },
      },
    });
  });

  it("switches the strategy and keeps the goal text when the start fails", async () => {
    const onSubmit = vi.fn<(input: StartRunInput) => Promise<boolean>>().mockResolvedValue(false);
    render(
      <RunLauncher
        open
        config={config()}
        busy={false}
        error="spawn failed"
        inventory={inventory()}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    await userEvent.click(screen.getByRole("radio", { name: /Tighten|tighten/i }));
    await userEvent.type(screen.getByLabelText("目标"), "do the thing");
    await userEvent.click(screen.getByRole("button", { name: /启动运行/ }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ strategy: "tighten" });
    expect(screen.getByLabelText("目标")).toHaveValue("do the thing");
    expect(screen.getByRole("alert")).toHaveTextContent("spawn failed");
  });

  it("warns and locks the picker when no usable CLI was detected", async () => {
    render(
      <RunLauncher
        open
        config={config()}
        busy={false}
        error={undefined}
        inventory={{ scannedAt: "2026-10-30T00:00:00.000Z", home: "/h", clis: [] }}
        onClose={() => undefined}
        onSubmit={vi.fn().mockResolvedValue(true)}
      />,
    );

    expect(await screen.findByText(/未检测到可用全局 CLI 清单/)).toBeVisible();
    for (const select of screen.getAllByLabelText("CLI")) {
      expect(select).toBeDisabled();
    }
  });

  it("previews the experience that would be injected", async () => {
    api.retrieveExperience.mockResolvedValue({
      note: "策略提示来自已验证经验。",
      items: [{ id: "e1", summary: "Prefer a changed-files ratchet", conditions: [], tags: [] }],
    });
    render(
      <RunLauncher
        open
        config={config()}
        scope={scope}
        busy={false}
        error={undefined}
        inventory={inventory()}
        onClose={() => undefined}
        onSubmit={vi.fn().mockResolvedValue(true)}
      />,
    );

    await userEvent.type(screen.getByLabelText("目标"), "tighten the quality gate");
    await waitFor(() => expect(api.retrieveExperience).toHaveBeenCalled(), { timeout: 2_000 });
    expect(await screen.findByText(/将注入 1 条已验证经验/)).toBeVisible();
  });

  it("collapses the role section and stays closed when open is false", async () => {
    const { rerender } = render(
      <RunLauncher
        open
        config={config()}
        busy={false}
        error={undefined}
        inventory={inventory()}
        onClose={() => undefined}
        onSubmit={vi.fn().mockResolvedValue(true)}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /角色与模型/ }));
    expect(screen.queryAllByLabelText("CLI")).toHaveLength(0);

    rerender(
      <RunLauncher
        open={false}
        config={config()}
        busy={false}
        error={undefined}
        inventory={inventory()}
        onClose={() => undefined}
        onSubmit={vi.fn().mockResolvedValue(true)}
      />,
    );
    expect(screen.queryByLabelText("目标")).toBeNull();
  });

  it("skips role rows the project config does not define", () => {
    render(
      <RoleBindingGrid
        roles={["ghost", "worker"]}
        config={config()}
        bindings={{}}
        fallback={{ cli: "kimi", model: "m1", reasoning: "high" }}
        inventory={inventory()}
        strategyDefinition={undefined}
        useCliPicker
        showCliPicker
        onChange={() => undefined}
      />,
    );
    expect(screen.getAllByLabelText("CLI")).toHaveLength(1);
  });
});
