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

/** Desktop only: pick a local folder and register it into the multi-project workspace. */
export function useDesktopProject({ desktopShell, setBusy, setError }: UseDesktopProjectOptions) {
  const addDesktopProject = useCallback(async () => {
    if (!desktopShell) return;
    setBusy(true);
    setError(undefined);
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "选择要接入的代码项目",
      });
      if (typeof selected !== "string") {
        return;
      }
      let status = await invoke<DesktopShellStatus>("desktop_open_project", {
        projectPath: selected,
      });
      if (status.state === "needsSetup") {
        const ok = window.confirm(
          `${status.message}\n\n路径：${selected}\n\n是否现在初始化 agent-team.yaml 并接入？`,
        );
        if (!ok) {
          // Restore previous multi-project workspace after a cancelled setup.
          await invoke<DesktopShellStatus>("desktop_retry");
          return;
        }
        status = await invoke<DesktopShellStatus>("desktop_initialize_project");
      }
      if (status.state === "error" || status.state === "busy") {
        setError(
          [status.message, status.technicalDetail].filter(Boolean).join("\n"),
        );
        return;
      }
      // ready/starting: native shell navigates to the new control session.
    } catch (requestError) {
      const detail = runActionErrorMessage(requestError);
      setError(
        /not found|Command .* not found/i.test(detail)
          ? "当前桌面端权限未覆盖工作台页面，无法添加项目。请安装最新桌面构建后重试。"
          : detail,
      );
    } finally {
      setBusy(false);
    }
  }, [desktopShell, setBusy, setError]);

  return addDesktopProject;
}
