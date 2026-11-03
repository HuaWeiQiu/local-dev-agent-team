// @vitest-environment jsdom
import "./web/dom-setup.js";
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ExperienceDetail } from "../web/src/components/experience/ExperienceDetail.js";
import { actionsFor, conditionLabels, portabilityLabel, tagLabels } from "../web/src/components/experience/detail/model.js";
import type { ExperienceEntry } from "../web/src/types.js";

function entry(patch: Partial<ExperienceEntry> = {}): ExperienceEntry {
  return {
    id: "e1",
    project: "demo",
    status: "candidate",
    summary: "并发刷新要先合并再写",
    conditions: ["任务涉及 refresh", "存在并发写入", "a", "b", "c", "d"],
    tags: ["react", "state", "async", "ui", "hooks", "cache", "extra"],
    sourceRunId: "20261030T121040Z-add-a-locale-option-to-greet-7b1d23",
    sensitivity: "low",
    scope: "project",
    portability: "cross-project",
    hitCount: 3,
    successCount: 1,
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T12:00:00.000Z",
    ...patch,
  };
}

type DetailProps = ComponentProps<typeof ExperienceDetail>;

function props(patch: Partial<DetailProps> = {}): DetailProps {
  return {
    entry: entry(),
    busy: false,
    onPromote: vi.fn(),
    onReject: vi.fn(),
    onShare: vi.fn(),
    onRetire: vi.fn(),
    ...patch,
  };
}

describe("experience detail model", () => {
  it("grants actions by scope, status and portability", () => {
    expect(actionsFor(entry())).toMatchObject({ promote: true, reject: true, share: false, retire: false });

    const verified = entry({ status: "verified" });
    expect(actionsFor(verified)).toMatchObject({ promote: false, share: true, retire: true, reject: true });

    const highSensitivity = entry({ status: "verified", sensitivity: "high" });
    expect(actionsFor(highSensitivity).share).toBe(false);

    const projectOnly = entry({ status: "verified", portability: "project-bound" });
    expect(actionsFor(projectOnly).share).toBe(false);

    const shared = entry({ status: "retired", scope: "shared" });
    expect(actionsFor(shared).readOnly).toBe(true);

    const retired = entry({ status: "retired" });
    expect(actionsFor(retired).readOnly).toBe(true);
  });

  it("caps conditions and tags", () => {
    expect(conditionLabels(entry())).toHaveLength(5);
    expect(tagLabels(entry())).toHaveLength(6);
    expect(portabilityLabel(entry())).toBe("可跨项目");
    expect(portabilityLabel(entry({ portability: "project-bound" }))).toBe("仅本项目");
  });
});

describe("ExperienceDetail", () => {
  it("renders a candidate with promote and reject", async () => {
    const p = props();
    render(<ExperienceDetail {...(p)} />);
    expect(screen.getByText("并发刷新要先合并再写")).toBeVisible();
    expect(screen.getByText("候选")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /晋升/ }));
    expect(p.onPromote).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /拒绝/ }));
    expect(p.onReject).toHaveBeenCalled();
  });

  it("offers share and retire for a verified, portable entry", async () => {
    const p = props({ entry: entry({ status: "verified" }) });
    render(<ExperienceDetail {...(p)} />);
    await userEvent.click(screen.getByRole("button", { name: /共享/ }));
    await userEvent.click(screen.getByRole("button", { name: /退役/ }));
    expect(p.onShare).toHaveBeenCalled();
    expect(p.onRetire).toHaveBeenCalled();
  });

  it("shows the read-only hint when nothing applies", () => {
    render(<ExperienceDetail {...(props({ entry: entry({ status: "retired", scope: "shared" }) }))} />);
    expect(screen.getByText("只读")).toBeVisible();
  });

  it("explains a rejection reason", () => {
    render(<ExperienceDetail {...(props({ entry: entry({ failureReason: "证据不足" }) }))} />);
    expect(screen.getByText(/证据不足/)).toBeVisible();
  });

  it("says when there are no conditions and hides empty tags", () => {
    render(<ExperienceDetail {...(props({ entry: entry({ conditions: [], tags: [] }) }))} />);
    expect(screen.getByText("无")).toBeVisible();
    expect(screen.queryByText("标签")).toBeNull();
  });

  it("disables the actions while busy", () => {
    render(<ExperienceDetail {...(props({ busy: true }))} />);
    expect(screen.getByRole("button", { name: /晋升/ })).toBeDisabled();
  });

  it("shows source, hits and update time", () => {
    render(<ExperienceDetail {...(props())} />);
    expect(screen.getByText("来源")).toBeVisible();
    expect(screen.getByText("命中")).toBeVisible();
    expect(screen.getByText("3")).toBeVisible();
  });
});
