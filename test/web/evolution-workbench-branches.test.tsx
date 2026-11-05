// @vitest-environment jsdom
import "./dom-setup.js";
import { projectScope } from "./support/scope.js";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `EvolutionWorkbench` decides its own two branches from the model the hook returns:
 * "no snapshot yet" (loading / error) and "visible error banner". Its eight lines flipped
 * between runs because they were reached only when a consumer's async load happened to
 * settle in a particular order. Here the model is given, so the branch is chosen by the
 * test — the same seam `JevPanel` got.
 */
const modelState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("../../web/src/components/evolution/workbench/useEvolutionWorkbench.js", () => ({
  useEvolutionWorkbench: () => modelState.current,
}));
vi.mock("../../web/src/hooks/useMediaQuery.js", () => ({ useMediaQuery: () => false }));
vi.mock("../../web/src/components/evolution/workbench/panes.js", () => ({
  EvolutionUnavailable: ({ loading, error }: { loading: boolean; error?: string }) => (
    <div data-testid="unavailable">{loading ? "loading" : (error ?? "empty")}</div>
  ),
  EvolutionPanes: () => <div data-testid="panes" />,
  LockBanner: () => <div data-testid="lock" />,
}));
vi.mock("../../web/src/components/evolution/AutomationBar.js", () => ({
  AutomationBar: () => <div data-testid="automation" />,
}));
vi.mock("../../web/src/components/EvolutionDecisionDialog.js", () => ({
  EvolutionDecisionDialog: () => null,
}));
vi.mock("../../web/src/components/EvolutionProposalDialog.js", () => ({
  EvolutionProposalDialog: () => null,
}));

const { EvolutionWorkbench } = await import("../../web/src/components/EvolutionWorkbench.js");

/**
 * A project *selection*, not the project record: the workbench scopes its
 * requests by `{mode, projectId}`. The old `{id, name, root}` passed only
 * because a cast hid the difference.
 */
const scope = projectScope();
const config = { version: 1, defaults: {}, ui: {} } as never;

function model(patch: Record<string, unknown>) {
  modelState.current = {
    snapshot: undefined,
    loading: false,
    error: undefined,
    visibleError: undefined,
    proposals: [],
    selectedId: undefined,
    selected: undefined,
    audit: [],
    completed: [],
    busy: false,
    filter: "all",
    query: "",
    ...patch,
  };
}

beforeEach(() => {
  model({});
});

describe("EvolutionWorkbench branches", () => {
  it("shows the loading state while there is no snapshot", () => {
    model({ loading: true });
    render(<EvolutionWorkbench scope={scope} config={config} />);
    expect(screen.getByTestId("unavailable")).toHaveTextContent("loading");
    expect(screen.queryByTestId("panes")).toBeNull();
  });

  it("shows the load error when the fetch failed", () => {
    model({ error: "读取失败" });
    render(<EvolutionWorkbench scope={scope} config={config} />);
    expect(screen.getByTestId("unavailable")).toHaveTextContent("读取失败");
  });

  it("shows a visible error banner above a loaded snapshot", () => {
    model({ snapshot: {}, visibleError: "轮询失败" });
    render(<EvolutionWorkbench scope={scope} config={config} />);
    expect(screen.getByRole("alert")).toHaveTextContent("轮询失败");
    expect(screen.getByTestId("panes")).toBeInTheDocument();
  });

  it("renders no banner when there is nothing to report", () => {
    model({ snapshot: {} });
    render(<EvolutionWorkbench scope={scope} config={config} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("panes")).toBeInTheDocument();
  });
});
