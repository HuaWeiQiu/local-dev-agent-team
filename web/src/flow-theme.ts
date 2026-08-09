import { useSyncExternalStore } from "react";
import { THEME_CHANGE_EVENT } from "./theme";

/**
 * xyflow 的 edge / Background / MiniMap 颜色通过 SVG 属性或内联样式传递，
 * 无法直接使用 CSS var()。这里从 getComputedStyle 读取 theme.css 令牌并缓存，
 * 主题切换（显式 data-theme 或系统 prefers-color-scheme）时失效重建。
 */
export interface FlowPalette {
  edge: string;
  dot: string;
  minimapMask: string;
  tones: Record<"success" | "danger" | "warning" | "active" | "neutral", string>;
}

let cached: FlowPalette | undefined;
let version = 0;

export function flowPalette(): FlowPalette {
  if (cached) {
    return cached;
  }
  // 允许在 Node（测试/SSR）环境安全调用：无 DOM 时直接返回回退色板。
  const styles =
    typeof document === "undefined" ? undefined : getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) =>
    styles ? styles.getPropertyValue(name).trim() || fallback : fallback;
  cached = {
    edge: token("--line-strong", "#8a9691"),
    dot: token("--line", "#d2d3cb"),
    minimapMask: withAlpha(token("--bg", "#f4f6f5"), 0.72),
    tones: {
      success: token("--success", "#26855f"),
      danger: token("--danger", "#c24b4b"),
      warning: token("--warning", "#c1812d"),
      active: token("--info", "#3574a6"),
      neutral: token("--muted", "#78827e"),
    },
  };
  return cached;
}

/** 订阅主题变化并返回递增版本号，供 useMemo 依赖以重建带颜色的图元素。 */
export function useThemeVersion(): number {
  return useSyncExternalStore(subscribeThemeChange, () => version, () => 0);
}

export function useFlowPalette(): FlowPalette {
  useThemeVersion();
  return flowPalette();
}

function subscribeThemeChange(onChange: () => void): () => void {
  const handle = () => {
    cached = undefined;
    version += 1;
    onChange();
  };
  window.addEventListener(THEME_CHANGE_EVENT, handle);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", handle);
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, handle);
    media.removeEventListener("change", handle);
  };
}

function withAlpha(color: string, alpha: number): string {
  const functional = color.match(/^([a-zA-Z]+)\((.*)\)$/);
  if (functional) {
    return `${functional[1]}(${functional[2]} / ${alpha})`;
  }
  return color;
}
