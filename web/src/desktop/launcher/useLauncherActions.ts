import { useCallback } from "react";
import {
  confirmForceRelease,
  confirmRelease,
  confirmRemove,
  isReleasable,
  pickDirectory,
  runCommand as execCommand,
  type LauncherPorts,
} from "./commands";
import { previewStatus } from "./model";
import type { DesktopProjectEntry, DesktopState, DesktopStatus } from "./types";

export interface LauncherActions {
  chooseProject(): Promise<void>;
  openProject(path: string): Promise<void>;
  removeProject(project: DesktopProjectEntry): Promise<void>;
  releaseLease(project: DesktopProjectEntry): Promise<void>;
  initialize(): Promise<void>;
  retry(): Promise<void>;
}

/** Intents that mutate the project list. */
export function useProjectActions({
  previewState,
  ports,
}: Input): Pick<LauncherActions, "chooseProject" | "openProject" | "removeProject" | "releaseLease"> {
  const { setStatus, setBusy } = ports;
  const chooseProject = useCallback(async () => {
    if (previewState) return chooseInPreview(setStatus, setBusy);
    const selected = await pickDirectory();
    if (selected === undefined) return;
    setStatus({ state: "starting", message: "正在检查项目" });
    await execCommand("desktop_open_project", ports, { projectPath: selected });
  }, [ports, previewState, setBusy, setStatus]);

  const openProject = useCallback(
    async (path: string) => {
      if (previewState) return;
      setStatus({ state: "starting", message: "正在打开项目" });
      await execCommand("desktop_open_project", ports, { projectPath: path });
    },
    [ports, previewState, setStatus],
  );

  const removeProject = useCallback(
    async (project: DesktopProjectEntry) => {
      if (previewState || !confirmRemove(project)) return;
      setStatus({ state: "starting", message: "正在更新项目列表" });
      await execCommand("desktop_remove_project", ports, { projectPath: project.path });
    },
    [ports, previewState, setStatus],
  );

  const releaseLease = useCallback(
    async (project: DesktopProjectEntry) => {
      if (previewState) return;
      if (!shouldRelease(project)) return;
      setStatus({ state: "starting", message: `正在释放 ${project.name} 的占用` });
      await execCommand("desktop_release_project_lease", ports, {
        projectPath: project.path,
        force: forcesRelease(project),
      });
    },
    [ports, previewState, setStatus],
  );

  return { chooseProject, openProject, removeProject, releaseLease };
}

/** Intents that move the current status forward. */
export function useLifecycleActions({
  previewState,
  ports,
}: Input): Pick<LauncherActions, "initialize" | "retry"> {
  const { setStatus, setBusy } = ports;
  const initialize = useCallback(async () => {
    if (previewState) return initializeInPreview(setStatus, setBusy);
    setStatus((current) => ({ ...current, state: "starting", message: "正在初始化项目" }));
    await execCommand("desktop_initialize_project", ports);
  }, [ports, previewState, setBusy, setStatus]);

  const retry = useCallback(async () => {
    if (previewState) return setStatus(previewStatus("needsProject"));
    setStatus((current) => ({ ...current, state: "starting", message: "正在重新打开" }));
    await execCommand("desktop_retry", ports);
  }, [ports, previewState, setStatus]);

  return { initialize, retry };
}

interface Input {
  previewState: DesktopState | undefined;
  ports: LauncherPorts;
}

/**
 * The launcher's six intents. In preview mode nothing touches the desktop
 * bridge: each action only walks the status forward so the UI can be shown.
 */
export function useLauncherActions(input: Input): LauncherActions {
  return { ...useProjectActions(input), ...useLifecycleActions(input) };
}

/** Releasable, confirmed once, and confirmed again when a run is live. */
function shouldRelease(project: DesktopProjectEntry): boolean {
  if (!isReleasable(project)) return false;
  if (!confirmRelease(project)) return false;
  return confirmForceRelease(project);
}

function forcesRelease(project: DesktopProjectEntry): boolean {
  return Boolean(project.hasActiveRun || project.occupancy === "active-run");
}

function chooseInPreview(
  setStatus: (status: DesktopStatus) => void,
  setBusy: (busy: boolean) => void,
): void {
  setBusy(true);
  setStatus({ state: "starting", message: "正在检查项目", projectName: "example-project" });
  window.setTimeout(() => {
    setStatus(previewStatus("needsSetup"));
    setBusy(false);
  }, 450);
}

function initializeInPreview(
  setStatus: (status: DesktopStatus) => void,
  setBusy: (busy: boolean) => void,
): void {
  setBusy(true);
  setStatus({ state: "starting", message: "正在初始化项目", projectName: "example-project" });
}
