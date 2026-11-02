// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RunEvidence } from "../../web/src/types.js";
import { EvidenceCenter } from "../../web/src/components/EvidenceCenter.js";
import { CliPanel } from "../../web/src/components/onboarding/panels.js";
import { EvolutionWorkbench } from "../../web/src/components/EvolutionWorkbench.js";
import type { DetectedCli } from "../../web/src/components/onboarding/panels.js";

const workbench = vi.hoisted(() => ({ dialogError: undefined as string | undefined }));

vi.mock("../../web/src/components/evolution/workbench/useEvolutionWorkbench.js", () => ({
  useEvolutionWorkbench: () => ({
    snapshot: { proposals: [], catalog: { strategies: [] }, automation: { status: "idle" } },
    loading: false,
    error: undefined,
    creating: true,
    decision: { proposalId: "p1" },
    busy: false,
    dialogError: workbench.dialogError,
    closeCreating: vi.fn(),
    submitProposal: vi.fn(),
    closeDecision: vi.fn(),
    submitDecision: vi.fn(),
    refresh: vi.fn(),
    requestedCycles: 1,
    setRequestedCycles: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

vi.mock("../../web/src/components/evolution/AutomationBar.js", () => ({
  AutomationBar: () => null,
}));

vi.mock("../../web/src/components/evolution/workbench/panes.js", () => ({
  EvolutionPanes: () => null,
  EvolutionUnavailable: () => null,
  LockBanner: () => null,
}));

vi.mock("../../web/src/components/EvolutionProposalDialog.js", () => ({
  EvolutionProposalDialog: () => <div data-testid="proposal-dialog" />,
}));

vi.mock("../../web/src/components/EvolutionDecisionDialog.js", () => ({
  EvolutionDecisionDialog: () => <div data-testid="decision-dialog" />,
}));

function evidence(readiness: RunEvidence["readiness"]): RunEvidence {
  return {
    runId: "r1",
    status: "running",
    readiness,
    checks: [],
    tasks: [],
    artifacts: [],
    artifactBytes: 0,
    diff: {
      available: false,
      changedFiles: [],
      baseCommit: "a".repeat(40),
      targetCommit: null,
      detail: "还没有集成差异",
    },
  } as unknown as RunEvidence;
}

describe("readinessLabel", () => {
  it.each([
    ["ready", "可交付"],
    ["attention", "需要处理"],
    ["in-progress", "证据生成中"],
  ] as const)("labels %s as %s", (readiness, label) => {
    render(
      <EvidenceCenter
        run={{ id: "r1", status: "running" } as never}
        evidence={evidence(readiness)}
        loading={false}
        onReadArtifact={vi.fn()}
      />,
    );

    expect(screen.getByText(label)).toBeTruthy();
  });
});

describe("CliFlags", () => {
  function cli(patch: Partial<DetectedCli> = {}): DetectedCli {
    return {
      id: "codex",
      label: "Codex",
      installed: true,
      runtimeSupported: true,
      authStatus: "ready",
      ...patch,
    } as DetectedCli;
  }

  it("shows the version, the warnings and the recommended marker together", () => {
    render(
      <CliPanel
        clis={[
          cli({ version: "1.2.3", runtimeSupported: false, authStatus: "missing" }),
        ]}
        recommendedCli="codex"
      />,
    );

    expect(screen.getByText("1.2.3")).toBeTruthy();
    expect(screen.getByText("不可调用")).toBeTruthy();
    expect(screen.getByText("未登录")).toBeTruthy();
    expect(screen.getByText("默认使用")).toBeTruthy();
  });

  it("shows nothing extra for a healthy, non-recommended CLI", () => {
    const { container } = render(<CliPanel clis={[cli()]} recommendedCli="grok" />);

    expect(container.textContent).not.toContain("默认使用");
    expect(container.textContent).not.toContain("不可调用");
    expect(container.textContent).not.toContain("未登录");
  });
});

describe("WorkbenchDialogs", () => {
  it("renders both dialogs the workbench model opens", () => {
    workbench.dialogError = undefined;
    render(
      <EvolutionWorkbench
        scope={{ mode: "single", projectId: "p1" } as never}
        config={{ roles: {} } as never}
      />,
    );

    expect(screen.getByTestId("proposal-dialog")).toBeTruthy();
    expect(screen.getByTestId("decision-dialog")).toBeTruthy();
  });

  it("forwards the dialog error to both dialogs", () => {
    workbench.dialogError = "保存失败";
    render(
      <EvolutionWorkbench
        scope={{ mode: "single", projectId: "p1" } as never}
        config={{ roles: {} } as never}
      />,
    );

    expect(screen.getByTestId("proposal-dialog")).toBeTruthy();
  });
});
