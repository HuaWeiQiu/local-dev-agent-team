import { useCallback, useState } from "react";
import { applyTheme, getInitialTheme, nextThemeMode, type ThemeMode } from "../theme";

/** 主题模式状态与循环切换（自 App.tsx 原样搬移）。 */
export function useThemeMode() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getInitialTheme());

  const cycleTheme = useCallback(() => {
    const next = nextThemeMode(themeMode);
    applyTheme(next);
    setThemeMode(next);
  }, [themeMode]);

  return { themeMode, cycleTheme };
}
