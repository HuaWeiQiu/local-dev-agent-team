// @vitest-environment jsdom
import "./dom-setup.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EvolutionProposal } from "../../web/src/types.js";
import { ProposalRail } from "../../web/src/components/evolution/ProposalRail.js";

function proposal(patch: Partial<EvolutionProposal> = {}): EvolutionProposal {
  return {
    id: "p-1",
    createdAt: "2026-11-02T00:00:00.000Z",
    status: "proposed",
    candidate: {
      kind: "strategy-blueprint",
      name: "balanced",
      definition: { topology: { mode: "parallel-dag" }, roleProfiles: {} },
    },
    policy: {
      version: 1,
      capabilities: {
        automaticExecution: false,
        automaticPromotion: false,
        networkPublication: false,
        secretStorage: false,
      },
      allowedPromptPaths: [],
    },
    transitions: [],
    application: null,
    ...patch,
  } as EvolutionProposal;
}

function props(patch: Record<string, unknown> = {}) {
  return {
    proposals: [proposal()],
    totalCount: 1,
    selectedId: undefined,
    query: "",
    filter: "open" as const,
    busy: false,
    loading: false,
    createDisabled: false,
    singlePane: false,
    onQueryChange: vi.fn(),
    onFilterChange: vi.fn(),
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onRefresh: vi.fn(),
    ...patch,
  };
}

describe("ProposalRail", () => {
  it("renders one selectable row per proposal", () => {
    const onSelect = vi.fn();
    const { container } = render(<ProposalRail {...props({ onSelect })} />);

    const row = container.querySelector("ul li > button")!;
    fireEvent.click(row);

    expect(onSelect).toHaveBeenCalledWith("p-1");
  });

  it("marks the selected row", () => {
    const { container } = render(<ProposalRail {...props({ selectedId: "p-1" })} />);

    expect(container.querySelector("ul li > button")!.getAttribute("aria-current")).toBe("true");
  });

  it("passes query and filter changes upward", () => {
    const onQueryChange = vi.fn();
    const onFilterChange = vi.fn();
    render(<ProposalRail {...props({ onQueryChange, onFilterChange })} />);

    fireEvent.change(screen.getByLabelText("搜索候选"), { target: { value: "abc" } });
    fireEvent.change(screen.getByLabelText("候选状态筛选"), { target: { value: "archived" } });

    expect(onQueryChange).toHaveBeenCalledWith("abc");
    expect(onFilterChange).toHaveBeenCalledWith("archived");
  });

  it("offers refresh and create from the header", () => {
    const onRefresh = vi.fn();
    const onCreate = vi.fn();
    render(<ProposalRail {...props({ onRefresh, onCreate })} />);

    fireEvent.click(screen.getByLabelText("刷新演进状态"));
    fireEvent.click(screen.getByTitle("新建候选"));

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("disables the actions while loading or busy", () => {
    render(<ProposalRail {...props({ loading: true, busy: true, createDisabled: true })} />);

    expect(screen.getByLabelText("刷新演进状态")).toHaveProperty("disabled", true);
    expect(screen.getByTitle("新建候选")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("搜索候选")).toHaveProperty("disabled", true);
  });

  it("explains an empty library and offers the first candidate", () => {
    const onCreate = vi.fn();
    render(<ProposalRail {...props({ proposals: [], totalCount: 0, onCreate })} />);

    expect(screen.getByText("还没有演进候选")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /新建候选/ }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("explains an empty result set without offering a new candidate", () => {
    render(<ProposalRail {...props({ proposals: [], totalCount: 3 })} />);

    expect(screen.getByText("没有符合条件的候选")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /新建候选/ })).toBeNull();
  });

  it("adds the chevron only in single-pane mode", () => {
    const { rerender } = render(<ProposalRail {...props()} />);
    expect(document.querySelector("svg.lucide-chevron-right")).toBeNull();

    rerender(<ProposalRail {...props({ singlePane: true })} />);
    expect(document.querySelector("svg.lucide-chevron-right")).toBeTruthy();
  });
});
