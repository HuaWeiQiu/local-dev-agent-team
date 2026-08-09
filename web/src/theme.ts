export type ThemeMode = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "agent-team-theme";
export const THEME_CHANGE_EVENT = "agent-team:theme-change";

export function getInitialTheme(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // localStorage 不可用时退化为跟随系统
  }
  return "system";
}

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", mode);
  }
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // 忽略持久化失败，主题仍然生效
  }
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

export function nextThemeMode(mode: ThemeMode): ThemeMode {
  return mode === "system" ? "light" : mode === "light" ? "dark" : "system";
}

export function themeModeLabel(mode: ThemeMode): string {
  return mode === "light" ? "浅色" : mode === "dark" ? "深色" : "跟随系统";
}
