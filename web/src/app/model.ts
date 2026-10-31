import {
  preferredMonitorPanel,
  runStatusLabel,
  summarizeGoal,
} from "../presentation";
import type { ReactNode } from "react";
import type { PaletteGroup } from "../shell/CommandPalette";
import type { WorkspaceMode } from "../shell/nav";
import type { ProjectScope, RunSummary, WorkspaceInfo } from "../types";

/** Tauri detection can throw outside the desktop shell. */
export function detectDesktopShell(): boolean {
  try {
    return isTauriLike();
  } catch {
    return false;
  }
}

function isTauriLike(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

export function scopeOf(
  workspace: WorkspaceInfo | undefined,
  projectId: string | undefined,
): ProjectScope | undefined {
  if (!workspace || !projectId) return undefined;
  return { mode: workspace.mode, projectId };
}

export function scopeKeyOf(scope: ProjectScope | undefined): string | undefined {
  return scope ? `${scope.mode}:${scope.projectId}` : undefined;
}

/** The panel worth opening first for a run that is already in trouble. */
export function earlyPanelFor(summary: RunSummary | undefined): "graph" | "activity" {
  if (!summary) return "graph";
  const hasTasks = Object.values(summary.taskCounts).some((count) => count > 0);
  return preferredMonitorPanel({
    status: summary.status,
    tasks: hasTasks ? [{}] : [],
    ...(summary.error ? { error: summary.error } : {}),
  });
}

/** Keyboard shortcuts: command palette, then "N" for a new run. */
export function shortcutFor(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}): "palette" | "launcher" | undefined {
  const withModifier = event.metaKey || event.ctrlKey;
  if (withModifier && event.key.toLowerCase() === "k") return "palette";
  if (event.key !== "n" || withModifier || event.altKey) return undefined;
  if (isTyping(event.target)) return undefined;
  if (document.querySelector("[role=dialog]")) return undefined;
  return "launcher";
}

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) return true;
  return element.isContentEditable;
}

export interface PaletteInput {
  workspace: WorkspaceInfo | undefined;
  config: unknown;
  runs: RunSummary[];
  onNewRun(): void;
  onOnboarding(): void;
  onCleanup(): void;
  onCycleTheme(): void;
  navigate(mode: WorkspaceMode): void;
  onSelectRun(runId: string): void;
  onSelectProject(projectId: string): void;
  icons: {
    plus: ReactNode;
    shield: ReactNode;
    trash: ReactNode;
    monitor: ReactNode;
    grid: ReactNode;
    workflow: ReactNode;
    sparkles: ReactNode;
    book: ReactNode;
    folderCog: ReactNode;
    settings: ReactNode;
    folderSync: ReactNode;
  };
}

/** Command palette groups; each group is built by its own function. */
export function paletteGroupsOf(input: PaletteInput): PaletteGroup[] {
  if (!input.workspace) return [];
  return [
    { heading: "操作", items: actionItems(input) },
    { heading: "页面", items: pageItems(input) },
    { heading: "运行", items: runItems(input) },
    { heading: "项目", items: projectItems(input) },
  ];
}

function actionItems(input: PaletteInput): PaletteGroup["items"] {
  const icons = input.icons;
  return [
    ...(input.config
      ? [{ id: "new-run", label: "新建运行", hint: "N", icon: icons.plus, run: input.onNewRun }]
      : []),
    {
      id: "onboarding",
      label: "项目初始化向导",
      icon: icons.shield,
      keywords: ["质量", "配置", "onboarding", "setup"],
      run: input.onOnboarding,
    },
    {
      id: "cleanup",
      label: "清理本地运行历史",
      icon: icons.trash,
      keywords: ["清理", "删除"],
      run: input.onCleanup,
    },
    {
      id: "theme",
      label: "切换主题",
      icon: icons.monitor,
      keywords: ["深色", "浅色", "dark", "light"],
      run: input.onCycleTheme,
    },
  ];
}

function pageItems(input: PaletteInput): PaletteGroup["items"] {
  const icons = input.icons;
  const goTo = (mode: WorkspaceMode) => () => input.navigate(mode);
  return [
    { id: "go-board", label: "看板", icon: icons.grid, run: goTo("monitor") },
    ...(input.config
      ? [
          { id: "go-design", label: "策略编排", icon: icons.workflow, run: goTo("design") },
          { id: "go-evolution", label: "演进工作台", icon: icons.sparkles, run: goTo("evolution") },
          { id: "go-experience", label: "经验库", icon: icons.book, run: goTo("experience") },
        ]
      : []),
    { id: "go-project", label: "项目设置", icon: icons.folderCog, run: goTo("project") },
    { id: "go-settings", label: "全局设置", icon: icons.settings, run: goTo("settings") },
  ];
}

function runItems(input: PaletteInput): PaletteGroup["items"] {
  return input.runs.slice(0, 40).map((item) => ({
    id: `run-${item.id}`,
    label: summarizeGoal(item.goal, 60),
    hint: runStatusLabel(item.status),
    keywords: [item.id, item.status],
    run: () => input.onSelectRun(item.id),
  }));
}

function projectItems(input: PaletteInput): PaletteGroup["items"] {
  const workspace = input.workspace;
  if (!workspace || workspace.projects.length <= 1) return [];
  return workspace.projects.map((project) => ({
    id: `project-${project.id}`,
    label: `切换到 ${project.name}`,
    icon: input.icons.folderSync,
    run: () => input.onSelectProject(project.id),
  }));
}
