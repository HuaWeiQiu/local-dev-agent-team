import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback } from "react";
import { runActionErrorMessage } from "../presentation";

interface DesktopShellStatus {
  state: string;
  message: string;
  projectName?: string;
  technicalDetail?: string;
}

interface UseDesktopProjectOptions {
  desktopShell: boolean;
  setBusy: (busy: boolean) => void;
  setError: (error: string | undefined) => void;
}

/** Everything the flow touches outside React, injected so it can be driven by tests. */
export interface DesktopProjectPorts {
  openDialog: typeof openDialog;
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  confirm: (message: string) => boolean;
}

export const desktopProjectPorts: DesktopProjectPorts = {
  openDialog,
  invoke: invoke as DesktopProjectPorts["invoke"],
  confirm: (message) => window.confirm(message),
};

const SETUP_PROMPT = "选择要接入的代码项目";

/**
 * Desktop only: pick a local folder and register it into the multi-project
 * workspace. A cancelled setup restores the previous workspace; a ready or
 * starting shell navigates on its own.
 */
export async function addDesktopProjectFlow(
  options: UseDesktopProjectOptions,
  ports: DesktopProjectPorts = desktopProjectPorts,
): Promise<void> {
  if (!options.desktopShell) return;
  options.setBusy(true);
  options.setError(undefined);
  try {
    const selected = await ports.openDialog({ directory: true, multiple: false, title: SETUP_PROMPT });
    if (typeof selected !== "string") return;
    const status = await openSelectedProject(selected, ports);
    if (!status) return;
    if (status.state === "error" || status.state === "busy") {
      options.setError([status.message, status.technicalDetail].filter(Boolean).join("\n"));
    }
    // ready/starting: the native shell navigates to the new control session.
  } catch (requestError) {
    options.setError(desktopProjectErrorCopy(requestError));
  } finally {
    options.setBusy(false);
  }
}

/** Registers the folder, offering to initialize it when setup is required. */
async function openSelectedProject(
  selected: string,
  ports: DesktopProjectPorts,
): Promise<DesktopShellStatus | undefined> {
  let status = await ports.invoke<DesktopShellStatus>("desktop_open_project", {
    projectPath: selected,
  });
  if (status.state !== "needsSetup") return status;
  const accepted = ports.confirm(
    `${status.message}\n\n路径：${selected}\n\n是否现在初始化 agent-team.yaml 并接入？`,
  );
  if (!accepted) {
    // Restore previous multi-project workspace after a cancelled setup.
    await ports.invoke<DesktopShellStatus>("desktop_retry");
    return undefined;
  }
  status = await ports.invoke<DesktopShellStatus>("desktop_initialize_project");
  return status;
}

/** A missing invoke permission has its own copy; everything else is the API error. */
function desktopProjectErrorCopy(requestError: unknown): string {
  const detail = runActionErrorMessage(requestError);
  return /not found|Command .* not found/i.test(detail)
    ? "当前桌面端权限未覆盖工作台页面，无法添加项目。请安装最新桌面构建后重试。"
    : detail;
}

/** Desktop only: the callback the workbench binds to its "add project" button. */
export function useDesktopProject(options: UseDesktopProjectOptions) {
  const { desktopShell, setBusy, setError } = options;
  return useCallback(
    async () => await addDesktopProjectFlow({ desktopShell, setBusy, setError }),
    [desktopShell, setBusy, setError],
  );
}
