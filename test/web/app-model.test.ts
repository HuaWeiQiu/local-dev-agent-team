// @vitest-environment jsdom
import "./dom-setup.js";
import { describe, expect, it } from "vitest";
import {
  detectDesktopShell,
  earlyPanelFor,
  paletteGroupsOf,
  scopeKeyOf,
  scopeOf,
  shortcutFor,
} from "../../web/src/app/model.js";
import type { RunSummary, WorkspaceInfo } from "../../web/src/types.js";

function summary(patch: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "r-1",
    goal: "g",
    status: "completed",
    taskCounts: { passed: 0 },
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    ...patch,
  } as unknown as RunSummary;
}

function workspace(): WorkspaceInfo {
  return {
    mode: "single",
    projects: [
      { id: "p1", name: "demo", root: "/repo", hasConfig: true },
      { id: "p2", name: "other", root: "/other", hasConfig: true },
    ],
    defaultProjectId: "p1",
  } as unknown as WorkspaceInfo;
}

function key(patch: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: "n",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    target: document.body,
    ...patch,
  } as unknown as KeyboardEvent;
}

const icons = {
  plus: null,
  shield: null,
  trash: null,
  monitor: null,
  grid: null,
  workflow: null,
  sparkles: null,
  book: null,
  folderCog: null,
  settings: null,
  folderSync: null,
};

describe("app model", () => {
  it("derives the project scope and its key", () => {
    expect(scopeOf(workspace(), "p1")).toEqual({ mode: "single", projectId: "p1" });
    expect(scopeOf(undefined, "p1")).toBeUndefined();
    expect(scopeOf(workspace(), undefined)).toBeUndefined();
    expect(scopeKeyOf({ mode: "single", projectId: "p1" })).toBe("single:p1");
    expect(scopeKeyOf(undefined)).toBeUndefined();
  });

  it("opens the panel that explains a troubled run first", () => {
    expect(earlyPanelFor(undefined)).toBe("graph");
    expect(earlyPanelFor(summary())).toBe("graph");
    expect(earlyPanelFor(summary({ taskCounts: { passed: 2 } as RunSummary["taskCounts"] }))).toBe(
      "graph",
    );
    expect(
      earlyPanelFor(summary({ status: "failed", error: "boom" } as Partial<RunSummary>)),
    ).toBe("graph");
  });

  it("maps keyboard shortcuts without hijacking typing", () => {
    expect(shortcutFor(key({ key: "k", metaKey: true }))).toBe("palette");
    expect(shortcutFor(key({ key: "k", ctrlKey: true }))).toBe("palette");
    expect(shortcutFor(key())).toBe("launcher");
    expect(shortcutFor(key({ metaKey: true }))).toBeUndefined();
    expect(shortcutFor(key({ altKey: true }))).toBeUndefined();
    expect(shortcutFor(key({ key: "x" }))).toBeUndefined();
    expect(
      shortcutFor(key({ target: { tagName: "INPUT", isContentEditable: false } as unknown as EventTarget })),
    ).toBeUndefined();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    expect(shortcutFor(key())).toBeUndefined();
    dialog.remove();
  });

  it("builds palette groups, including projects and runs", () => {
    const input = {
      workspace: workspace(),
      config: {},
      runs: [summary()],
      onNewRun: () => undefined,
      onOnboarding: () => undefined,
      onCleanup: () => undefined,
      onCycleTheme: () => undefined,
      navigate: () => undefined,
      onSelectRun: () => undefined,
      onSelectProject: () => undefined,
      icons,
    };
    const groups = paletteGroupsOf(input);
    expect(groups.map((group) => group.heading)).toEqual(["操作", "页面", "运行", "项目"]);
    expect(groups[3]?.items).toHaveLength(2);
    expect(paletteGroupsOf({ ...input, workspace: undefined })).toEqual([]);
    const single = paletteGroupsOf({
      ...input,
      workspace: { ...workspace(), projects: [workspace().projects[0]!] } as WorkspaceInfo,
    });
    expect(single[3]?.items).toEqual([]);
    expect(paletteGroupsOf({ ...input, config: undefined })[0]?.items).toHaveLength(3);
  });

  it("detects a non-Tauri browser as a plain shell", () => {
    expect(detectDesktopShell()).toBe(false);
  });
});
