import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  Bot,
  Check,
  ChevronRight,
  Circle,
  FolderOpen,
  LockKeyhole,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { errorMessage } from "./presentation";
import { applyTheme, getInitialTheme } from "./theme";

type DesktopState = "needsProject" | "needsSetup" | "starting" | "ready" | "busy" | "error";

interface DesktopProjectEntry {
  id: string;
  name: string;
  path: string;
  hasConfig: boolean;
  busy?: boolean;
  leasePid?: number;
  leaseCommand?: string;
  hasActiveRun?: boolean;
  occupancy?: "free" | "ours" | "foreign" | "stale" | "active-run" | string;
}

interface DesktopStatus {
  state: DesktopState;
  message: string;
  projectName?: string;
  technicalDetail?: string;
  projects?: DesktopProjectEntry[];
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
  const isBusy = status.state === "busy";
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

  async function openRegisteredProject(projectPath: string) {
    if (previewState) return;
    setStatus({ state: "starting", message: "正在打开项目" });
    await runCommand("desktop_open_project", setStatus, setBusy, { projectPath });
  }

  async function removeRegisteredProject(project: DesktopProjectEntry) {
    if (previewState) return;
    const ok = window.confirm(
      `项目：${project.name}\n路径：${project.path}\n\n仅从项目坞移除，不会删除磁盘上的任何文件。\n\n确定移除？`,
    );
    if (!ok) return;
    setStatus({ state: "starting", message: "正在更新项目列表" });
    await runCommand("desktop_remove_project", setStatus, setBusy, { projectPath: project.path });
  }

  async function releaseProjectLease(project: DesktopProjectEntry) {
    if (previewState) return;
    const occupancy = project.occupancy ?? (project.busy ? "foreign" : "free");
    if (occupancy === "ours" || occupancy === "free") return;

    const lines = [
      `项目：${project.name}`,
      project.leasePid ? `占用 PID：${project.leasePid}` : "占用：陈旧锁（进程已不存在）",
      project.leaseCommand ? `命令：${project.leaseCommand}` : "",
      project.hasActiveRun
        ? "检测：该项目可能仍有进行中的 multi-agent 任务"
        : "检测：未发现进行中的任务快照",
      "",
      occupancy === "stale"
        ? "将清理残留锁文件，不会结束任何进程。"
        : "将结束占用进程并清理锁，然后重新打开项目坞。",
    ].filter(Boolean);

    const ok = window.confirm(`${lines.join("\n")}\n\n确定释放占用？`);
    if (!ok) return;

    let force = false;
    if (project.hasActiveRun || occupancy === "active-run") {
      force = window.confirm(
        "该项目似乎仍有进行中的任务。\n强制释放会中断 multi-agent 运行。\n\n仍要强制释放吗？",
      );
      if (!force) return;
    }

    setStatus({ state: "starting", message: `正在释放 ${project.name} 的占用` });
    await runCommand("desktop_release_project_lease", setStatus, setBusy, {
      projectPath: project.path,
      force,
    });
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
          <div className={`launcher-hero-icon ${isError ? "is-error" : isBusy ? "is-busy" : ""}`}>
            {isError
              ? <AlertCircle size={30} />
              : isBusy
                ? <LockKeyhole size={30} />
                : <FolderOpen size={30} />}
          </div>
          <p className="launcher-kicker">{status.projectName ?? "本地项目"}</p>
          <h1>{headline(status)}</h1>
          <p className="launcher-message">{status.message}</p>

          {status.projects && status.projects.length > 0 && status.state !== "ready" && status.state !== "starting" && (
            <section className="launcher-project-dock" aria-label="已注册项目">
              <div className="launcher-project-dock-header">
                <strong>项目坞</strong>
                <span>{status.projects.length} 个项目 · 打开后可在工作台切换</span>
              </div>
              <ul className="launcher-project-list">
                {status.projects.map((project) => (
                  <li key={project.id} className="launcher-project-item">
                    <button
                      type="button"
                      className="launcher-project-open"
                      disabled={busy}
                      onClick={() => void openRegisteredProject(project.path)}
                    >
                      <span className="launcher-project-name">{project.name}</span>
                      <span className="launcher-project-path">{project.path}</span>
                      {project.leasePid ? (
                        <span className="launcher-project-lease">
                          PID {project.leasePid}
                          {project.leaseCommand ? ` · ${project.leaseCommand}` : ""}
                        </span>
                      ) : null}
                      <span
                        className={`launcher-project-badge ${
                          occupancyClass(project)
                        }`}
                      >
                        {occupancyLabel(project)}
                      </span>
                    </button>
                    <div className="launcher-project-actions">
                      {project.busy || project.occupancy === "stale" ? (
                        <button
                          type="button"
                          className="launcher-project-release"
                          disabled={busy}
                          onClick={() => void releaseProjectLease(project)}
                        >
                          释放占用
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="launcher-project-remove"
                        disabled={busy}
                        aria-label={`移除 ${project.name}`}
                        onClick={() => void removeRegisteredProject(project)}
                      >
                        移除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="launcher-actions">
            {status.state === "needsProject" && (
              <button className="launcher-primary" onClick={() => void chooseProject()} disabled={busy}>
                <FolderOpen size={18} />
                {status.projects && status.projects.length > 0 ? "添加项目文件夹" : "选择项目文件夹"}
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
            {(isError || isBusy) && (
              <>
                <button className="launcher-primary" onClick={() => void retry()} disabled={busy}>
                  <RotateCcw size={18} />
                  {isBusy ? "再次检查" : "重试"}
                </button>
                <button className="launcher-secondary" onClick={() => void chooseProject()} disabled={busy}>
                  添加 / 选择其他项目
                </button>
              </>
            )}
            {/* 已有项目列表时始终提供添加入口，避免只能切换不能新增 */}
            {status.projects && status.projects.length > 0
              && status.state !== "needsProject"
              && status.state !== "ready"
              && status.state !== "starting"
              && !needsSetup
              && !(isError || isBusy) && (
              <button className="launcher-primary" onClick={() => void chooseProject()} disabled={busy}>
                <FolderOpen size={18} />
                添加项目文件夹
                <ChevronRight size={17} />
              </button>
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

function occupancyLabel(project: DesktopProjectEntry): string {
  switch (project.occupancy) {
    case "active-run":
      return "有任务进行中";
    case "foreign":
      return "其他窗口占用";
    case "stale":
      return "残留锁可清理";
    case "ours":
      return "本窗口管理中";
    case "free":
      return project.hasConfig ? "可打开" : "需初始化";
    default:
      return project.busy ? "其他窗口占用" : project.hasConfig ? "可打开" : "需初始化";
  }
}

function occupancyClass(project: DesktopProjectEntry): string {
  if (project.occupancy === "active-run") return "is-active-run";
  if (project.occupancy === "stale") return "is-stale";
  if (project.occupancy === "foreign" || project.busy) return "is-busy";
  if (project.occupancy === "ours") return "is-ours";
  if (project.hasConfig) return "is-ready";
  return "is-setup";
}

function headline(status: DesktopStatus): string {
  if (status.state === "needsProject") {
    return status.projects && status.projects.length > 0 ? "打开或添加项目" : "选择一个项目";
  }
  if (status.state === "needsSetup") return "项目需要初始化";
  if (status.state === "busy") return "项目正在运行";
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
      detail: status.state === "ready"
        ? "已就绪"
        : status.state === "busy"
          ? "由另一进程管理"
          : opening
            ? "正在启动"
            : "等待项目",
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
  if (state === "busy") {
    return {
      state,
      message: "这个项目已由另一个 Agent Team 进程管理，正在运行的任务不会受到影响",
      projectName: "example-project",
      technicalDetail: "Another control service is already running with PID 42",
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
