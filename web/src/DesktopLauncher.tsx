import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  Bot,
  Check,
  ChevronRight,
  Circle,
  FolderOpen,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { errorMessage } from "./presentation";
import { applyTheme, getInitialTheme } from "./theme";

type DesktopState = "needsProject" | "needsSetup" | "starting" | "ready" | "error";

interface DesktopStatus {
  state: DesktopState;
  message: string;
  projectName?: string;
  technicalDetail?: string;
}

interface DesktopLauncherProps {
  previewState?: DesktopState;
}

const initialStatus: DesktopStatus = {
  state: "starting",
  message: "正在准备工作台",
};

export default function DesktopLauncher({ previewState }: DesktopLauncherProps) {
  const [status, setStatus] = useState<DesktopStatus>(
    previewState ? previewStatus(previewState) : initialStatus,
  );
  const [busy, setBusy] = useState(!previewState);

  useEffect(() => {
    applyTheme(getInitialTheme());
  }, []);

  useEffect(() => {
    if (previewState) return;
    void runCommand("desktop_boot", setStatus, setBusy);
  }, [previewState]);

  const checks = useMemo(() => launcherChecks(status), [status]);
  const isError = status.state === "error";
  const needsSetup = status.state === "needsSetup";

  async function chooseProject() {
    if (previewState) {
      setBusy(true);
      setStatus({ state: "starting", message: "正在检查项目", projectName: "example-project" });
      window.setTimeout(() => {
        setStatus(previewStatus("needsSetup"));
        setBusy(false);
      }, 450);
      return;
    }
    setBusy(true);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择代码项目",
      });
      if (typeof selected !== "string") {
        setBusy(false);
        return;
      }
      setStatus({ state: "starting", message: "正在检查项目" });
      await runCommand("desktop_open_project", setStatus, setBusy, { projectPath: selected });
    } catch (error) {
      setBusy(false);
      setStatus({
        state: "error",
        message: "无法选择这个项目",
        technicalDetail: errorMessage(error),
      });
    }
  }

  async function initializeProject() {
    if (previewState) {
      setBusy(true);
      setStatus({ state: "starting", message: "正在初始化项目", projectName: "example-project" });
      return;
    }
    setStatus((current) => ({ ...current, state: "starting", message: "正在初始化项目" }));
    await runCommand("desktop_initialize_project", setStatus, setBusy);
  }

  async function retry() {
    if (previewState) {
      setStatus(previewStatus("needsProject"));
      return;
    }
    setStatus((current) => ({ ...current, state: "starting", message: "正在重新打开" }));
    await runCommand("desktop_retry", setStatus, setBusy);
  }

  return (
    <div className="desktop-launcher">
      <header className="launcher-header">
        <div className="launcher-brand">
          <span className="launcher-brand-icon"><Bot size={20} strokeWidth={2.2} /></span>
          <strong>Agent Team</strong>
        </div>
        <span className="launcher-edition">桌面端</span>
      </header>

      <main className="launcher-main">
        <section className="launcher-content" aria-live="polite">
          <div className={`launcher-hero-icon ${isError ? "is-error" : ""}`}>
            {isError ? <AlertCircle size={30} /> : <FolderOpen size={30} />}
          </div>
          <p className="launcher-kicker">{status.projectName ?? "本地项目"}</p>
          <h1>{headline(status)}</h1>
          <p className="launcher-message">{status.message}</p>

          <div className="launcher-actions">
            {status.state === "needsProject" && (
              <button className="launcher-primary" onClick={() => void chooseProject()} disabled={busy}>
                <FolderOpen size={18} />
                选择项目文件夹
                <ChevronRight size={17} />
              </button>
            )}
            {needsSetup && (
              <>
                <button className="launcher-primary" onClick={() => void initializeProject()} disabled={busy}>
                  <Wrench size={18} />
                  初始化并打开
                  <ChevronRight size={17} />
                </button>
                <button className="launcher-secondary" onClick={() => void chooseProject()} disabled={busy}>
                  选择其他项目
                </button>
              </>
            )}
            {isError && (
              <>
                <button className="launcher-primary" onClick={() => void retry()} disabled={busy}>
                  <RotateCcw size={18} />
                  重试
                </button>
                <button className="launcher-secondary" onClick={() => void chooseProject()} disabled={busy}>
                  选择其他项目
                </button>
              </>
            )}
            {(status.state === "starting" || status.state === "ready") && (
              <div className="launcher-busy">
                <LoaderCircle size={18} className="launcher-spinner" />
                <span>{status.message}</span>
              </div>
            )}
          </div>

          <div className="launcher-checks" aria-label="准备状态">
            {checks.map((check) => (
              <div key={check.label} className={`launcher-check is-${check.state}`}>
                <span className="launcher-check-icon">
                  {check.state === "done" && <Check size={15} strokeWidth={2.8} />}
                  {check.state === "active" && <LoaderCircle size={15} className="launcher-spinner" />}
                  {check.state === "waiting" && <Circle size={13} />}
                </span>
                <span>{check.label}</span>
                <small>{check.detail}</small>
              </div>
            ))}
          </div>

          {status.technicalDetail && (
            <details className="launcher-details">
              <summary>技术详情</summary>
              <pre>{status.technicalDetail}</pre>
            </details>
          )}
        </section>
      </main>

      <footer className="launcher-footer">
        <ShieldCheck size={15} />
        <span>项目与运行记录保留在本机</span>
      </footer>
    </div>
  );
}

async function runCommand(
  command: string,
  setStatus: (status: DesktopStatus) => void,
  setBusy: (busy: boolean) => void,
  args?: Record<string, unknown>,
) {
  setBusy(true);
  try {
    setStatus(await invoke<DesktopStatus>(command, args));
  } catch (error) {
    setStatus({
      state: "error",
      message: "工作台暂时无法打开",
      technicalDetail: errorMessage(error),
    });
  } finally {
    setBusy(false);
  }
}

function headline(status: DesktopStatus): string {
  if (status.state === "needsProject") return "选择一个项目";
  if (status.state === "needsSetup") return "项目需要初始化";
  if (status.state === "error") return "没有打开成功";
  if (status.state === "ready") return "正在进入工作台";
  return "正在打开项目";
}

function launcherChecks(status: DesktopStatus) {
  const hasProject = Boolean(status.projectName);
  const configured = hasProject && status.state !== "needsSetup";
  const opening = status.state === "starting";
  return [
    {
      label: "项目",
      detail: hasProject ? status.projectName! : "等待选择",
      state: hasProject ? "done" : opening ? "active" : "waiting",
    },
    {
      label: "配置",
      detail: configured ? "已识别" : status.state === "needsSetup" ? "需要初始化" : "自动检查",
      state: configured ? "done" : opening && hasProject ? "active" : "waiting",
    },
    {
      label: "工作台",
      detail: status.state === "ready" ? "已就绪" : opening ? "正在启动" : "等待项目",
      state: status.state === "ready" ? "done" : opening && configured ? "active" : "waiting",
    },
  ] as Array<{ label: string; detail: string; state: "done" | "active" | "waiting" }>;
}

function previewStatus(state: DesktopState): DesktopStatus {
  if (state === "needsSetup") {
    return {
      state,
      message: "点击一次即可创建默认配置，不会改动现有代码",
      projectName: "example-project",
      technicalDetail: "未找到 agent-team.yaml",
    };
  }
  if (state === "error") {
    return {
      state,
      message: "请重试，或换一个项目文件夹",
      projectName: "example-project",
      technicalDetail: "示例：配置文件格式无效（第 12 行）",
    };
  }
  if (state === "ready") {
    return { state, message: "项目已就绪", projectName: "example-project" };
  }
  if (state === "starting") {
    return { state, message: "正在检查项目", projectName: "example-project" };
  }
  return { state, message: "选择后会自动检查并打开工作台" };
}
