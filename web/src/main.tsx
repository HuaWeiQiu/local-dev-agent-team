import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import "@xyflow/react/dist/style.css";
import App from "./App";
import DesktopLauncher from "./DesktopLauncher";
import { applyTheme, getInitialTheme } from "./theme";
import "./theme.css";
import "./styles.css";
import "./desktop-launcher.css";

// 首帧渲染前应用主题（服务端 CSP 禁止内联脚本，只能在这里尽早执行）；
// "system" 不写 data-theme，交给 CSS 媒体查询跟随系统。
applyTheme(getInitialTheme());

const previewState = import.meta.env.DEV
  ? desktopPreviewState(new URLSearchParams(window.location.search).get("desktop-preview"))
  : undefined;
const desktopMode =
  (isTauri() && !isControlServiceOrigin(window.location)) || previewState !== undefined;

createRoot(document.getElementById("root")!).render(
  desktopMode ? (
    <DesktopLauncher {...(previewState ? { previewState } : {})} />
  ) : (
    <StrictMode>
      <App />
    </StrictMode>
  ),
);

function desktopPreviewState(value: string | null) {
  return ["needsProject", "needsSetup", "starting", "ready", "busy", "error"].includes(value ?? "")
    ? (value as "needsProject" | "needsSetup" | "starting" | "ready" | "busy" | "error")
    : undefined;
}

function isControlServiceOrigin(location: Location) {
  return (
    location.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname) &&
    new URLSearchParams(location.search).get("desktop-runtime") === "1"
  );
}
