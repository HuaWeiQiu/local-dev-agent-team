import { useCallback, useEffect, useState } from "react";
import { getDesktopSettings } from "../api";
import type { CliInventory, RoleBindingInput } from "../types";

/**
 * 桌面端全局设置（角色默认绑定、CLI 盘点与选型开关）的读取与自动刷新：
 * 挂载时拉取一次；开启「回到窗口时检测」时在窗口聚焦/可见时重新盘点。
 */
export function useDesktopSettings() {
  const [roleDefaults, setRoleDefaults] = useState<Record<string, RoleBindingInput>>({});
  const [cliInventory, setCliInventory] = useState<CliInventory>();
  const [showCliPicker, setShowCliPicker] = useState(true);
  const [autoDetectOnFocus, setAutoDetectOnFocus] = useState(true);

  const refreshDesktopSettings = useCallback(async () => {
    try {
      // Soft read: server invalidates cache when CLI config mtime fingerprint changes.
      const response = await getDesktopSettings();
      setRoleDefaults(response.settings.defaults.roles);
      setCliInventory(response.inventory);
      setShowCliPicker(response.settings.ui.showCliPickerInRunLauncher !== false);
      const auto = response.settings.ui.autoDetectCliConfig !== false
        && response.settings.ui.autoDetectOnFocus !== false;
      setAutoDetectOnFocus(auto);
    } catch {
      // Settings require desktop session; plain browser serve may 401 — ignore.
    }
  }, []);

  useEffect(() => {
    void refreshDesktopSettings();
  }, [refreshDesktopSettings]);

  // When user returns to the app after editing ~/.codex/config.toml etc., refresh inventory.
  // Respects settings → 「回到窗口时检测」; open launcher always refreshes (manual path).
  useEffect(() => {
    if (!autoDetectOnFocus) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshDesktopSettings();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [autoDetectOnFocus, refreshDesktopSettings]);

  return { roleDefaults, cliInventory, showCliPicker, refreshDesktopSettings };
}
