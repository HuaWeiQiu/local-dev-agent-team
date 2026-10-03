// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OnboardingWizard, parseCommandLine } from "../../web/src/components/OnboardingWizard.js";
import type { OnboardingStatus } from "../../web/src/types.js";

function status(patch: Partial<OnboardingStatus> = {}): OnboardingStatus {
  return {
    projectId: "p",
    projectName: "demo",
    source: "detected",
    configPath: "/repo/agent-team.yaml",
    needsSetup: true,
    detection: {
      root: "/repo",
      name: "demo",
      isGitRepo: true,
      defaultBranch: "main",
      ecosystems: ["node"],
      packageManager: "pnpm",
      commands: [
        { role: "typecheck", label: "pnpm run check", command: { command: "pnpm", args: ["run", "check"] }, source: "package.json scripts.check", selected: true },
        { role: "test", label: "pnpm run test", command: { command: "pnpm", args: ["run", "test"] }, source: "package.json scripts.test", selected: true },
        { role: "build", label: "pnpm run build", command: { command: "pnpm", args: ["run", "build"] }, source: "package.json scripts.build", selected: false },
      ],
    },
    current: { commands: [] },
    clis: [{ id: "codex", installed: true, runtimeSupported: true, version: "1.2.3", authStatus: "present" }],
    recommendedCli: "codex",
    ...patch,
  };
}

describe("parseCommandLine", () => {
  it("splits on whitespace and never builds a shell string", () => {
    expect(parseCommandLine("  make   verify  ")).toEqual({ command: "make", args: ["verify"] });
    expect(parseCommandLine("   ")).toBeUndefined();
  });
});

describe("OnboardingWizard", () => {
  it("saves the pre-selected detected commands plus a custom one", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<OnboardingWizard open status={status()} busy={false} error={undefined} onSave={onSave} onSkip={vi.fn()} />);

    expect(screen.getByText("默认使用")).toBeTruthy();
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([true, true, false]);

    await user.click(boxes[2]!);
    await user.click(boxes[0]!);
    await user.type(screen.getByLabelText("额外命令"), "make verify");
    await user.click(screen.getByRole("button", { name: "保存到 agent-team.yaml" }));

    expect(onSave).toHaveBeenCalledWith([
      { command: "pnpm", args: ["run", "test"] },
      { command: "pnpm", args: ["run", "build"] },
      { command: "make", args: ["verify"] },
    ]);
  });

  it("skips without saving and warns when no CLI is installed", async () => {
    const onSkip = vi.fn();
    const onSave = vi.fn();
    const user = userEvent.setup();
    const empty = status({ clis: [], detection: { ...status().detection, commands: [] } });
    render(<OnboardingWizard open status={empty} busy={false} error="boom" onSave={onSave} onSkip={onSkip} />);

    expect(screen.getByText(/未检测到可用的/)).toBeTruthy();
    expect(screen.getByText(/没有从仓库中检测到/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("boom");
    await user.click(screen.getByRole("button", { name: "先用默认值" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("preselects the configured commands once agent-team.yaml exists", () => {
    render(
      <OnboardingWizard
        open
        status={status({ source: "file", needsSetup: false, current: { commands: [{ command: "pnpm", args: ["run", "build"] }] } })}
        busy={false}
        error={undefined}
        onSave={vi.fn()}
        onSkip={vi.fn()}
      />,
    );
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([false, false, true]);
  });
});
