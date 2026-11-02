// @vitest-environment jsdom
import "./dom-setup.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExperienceEntry } from "../../web/src/types.js";
import { ExperienceList } from "../../web/src/components/experience/ExperienceList.js";

function entry(patch: Partial<ExperienceEntry> = {}): ExperienceEntry {
  return {
    id: "e1",
    summary: "Fix the flaky test",
    status: "candidate",
    scope: "project",
    hitCount: 3,
    updatedAt: "2026-11-02T00:00:00.000Z",
    ...patch,
  } as ExperienceEntry;
}

function props(patch: Record<string, unknown> = {}) {
  return {
    entries: [entry()],
    total: 1,
    selectedId: undefined,
    query: "",
    filter: "all" as const,
    busy: false,
    onQueryChange: vi.fn(),
    onFilterChange: vi.fn(),
    onSelect: vi.fn(),
    onResetFilters: vi.fn(),
    ...patch,
  };
}

describe("ExperienceList", () => {
  it("shows the total when nothing is filtered", () => {
    render(<ExperienceList {...props({ total: 4 })} />);

    expect(screen.getByText("4 条")).toBeTruthy();
  });

  it("shows matched over total when a query filters the list", () => {
    render(<ExperienceList {...props({ query: "flaky", total: 4 })} />);

    expect(screen.getByText("1 / 4")).toBeTruthy();
  });

  it("passes the query and the filter change upward", () => {
    const onQueryChange = vi.fn();
    const onFilterChange = vi.fn();
    render(<ExperienceList {...props({ onQueryChange, onFilterChange })} />);

    fireEvent.change(screen.getByLabelText("搜索经验"), { target: { value: "abc" } });
    fireEvent.change(screen.getByLabelText("筛选"), { target: { value: "verified" } });

    expect(onQueryChange).toHaveBeenCalledWith("abc");
    expect(onFilterChange).toHaveBeenCalledWith("verified");
  });

  it("selects an entry and marks the selected row", () => {
    const onSelect = vi.fn();
    render(<ExperienceList {...props({ onSelect, selectedId: "e1" })} />);

    const row = screen.getByRole("button", { name: /Fix the flaky test/ });
    fireEvent.click(row);

    expect(onSelect).toHaveBeenCalledWith("e1");
    expect(row.getAttribute("aria-current")).toBe("true");
  });

  it("disables the toolbar and the rows while the list is busy", () => {
    render(<ExperienceList {...props({ busy: true })} />);

    expect(screen.getByLabelText("搜索经验")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("筛选")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /Fix the flaky test/ })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("explains an empty library", () => {
    render(<ExperienceList {...props({ entries: [], total: 0 })} />);

    expect(screen.getByText("暂无经验。跑完任务后会出现候选。")).toBeTruthy();
    expect(screen.queryByText("清除筛选")).toBeNull();
  });

  it("offers to clear the filters when the filter hid everything", () => {
    const onResetFilters = vi.fn();
    render(
      <ExperienceList
        {...props({ entries: [], total: 3, filter: "verified", onResetFilters })}
      />,
    );

    expect(screen.getByText("无匹配项")).toBeTruthy();
    fireEvent.click(screen.getByText("清除筛选"));

    expect(onResetFilters).toHaveBeenCalledTimes(1);
  });

  it("does not offer to clear filters for an empty query on an empty list", () => {
    render(<ExperienceList {...props({ entries: [], total: 0, busy: true })} />);

    expect(screen.queryByText("清除筛选")).toBeNull();
  });
});
