import {
  AlertCircle,
  Bot,
  Check,
  ChevronRight,
  Circle,
  FolderOpen,
  LoaderCircle,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import type { LauncherCheck } from "./model";
import { headline, occupancyClass, occupancyLabel } from "./model";
import { showsRelease } from "./commands";
import type { DesktopProjectEntry, DesktopStatus } from "./types";

export function LauncherHeader() {
  return (
    <header className="launcher-header">
      <div className="launcher-brand">
        <span className="launcher-brand-icon">
          <Bot size={20} strokeWidth={2.2} />
        </span>
        <strong>Agent Team</strong>
      </div>
      <span className="launcher-edition">桌面端</span>
    </header>
  );
}

export function LauncherHero({ status }: { status: DesktopStatus }) {
  const isError = status.state === "error";
  const isBusy = status.state === "busy";
  return (
    <>
      <div className={`launcher-hero-icon ${isError ? "is-error" : isBusy ? "is-busy" : ""}`}>
        {isError ? <AlertCircle size={30} /> : isBusy ? <LockKeyhole size={30} /> : <FolderOpen size={30} />}
      </div>
      <p className="launcher-kicker">{status.projectName ?? "本地项目"}</p>
      <h1>{headline(status)}</h1>
      <p className="launcher-message">{status.message}</p>
    </>
  );
}

export function ProjectDock({
  status,
  busy,
  onOpen,
  onRelease,
  onRemove,
}: {
  status: DesktopStatus;
  busy: boolean;
  onOpen(projectPath: string): void;
  onRelease(project: DesktopProjectEntry): void;
  onRemove(project: DesktopProjectEntry): void;
}) {
  if (!showsProjectDock(status)) return null;
  const projects = status.projects ?? [];
  return (
    <section className="launcher-project-dock" aria-label="已注册项目">
      <div className="launcher-project-dock-header">
        <strong>项目坞</strong>
        <span>{projects.length} 个项目 · 打开后可在工作台切换</span>
      </div>
      <ul className="launcher-project-list">
        {projects.map((project) => (
          <ProjectRow
            key={project.id}
            project={project}
            busy={busy}
            onOpen={onOpen}
            onRelease={onRelease}
            onRemove={onRemove}
          />
        ))}
      </ul>
    </section>
  );
}

/** The dock only appears while a project is being chosen. */
function showsProjectDock(status: DesktopStatus): boolean {
  if ((status.projects?.length ?? 0) === 0) return false;
  return status.state !== "ready" && status.state !== "starting";
}

function ProjectRow({
  project,
  busy,
  onOpen,
  onRelease,
  onRemove,
}: {
  project: DesktopProjectEntry;
  busy: boolean;
  onOpen(projectPath: string): void;
  onRelease(project: DesktopProjectEntry): void;
  onRemove(project: DesktopProjectEntry): void;
}) {
  return (
    <li className="launcher-project-item">
      <button
        type="button"
        className="launcher-project-open"
        disabled={busy}
        onClick={() => onOpen(project.path)}
      >
        <span className="launcher-project-name">{project.name}</span>
        <span className="launcher-project-path">{project.path}</span>
        {project.leasePid ? <LeaseLine project={project} /> : null}
        <span className={`launcher-project-badge ${occupancyClass(project)}`}>
          {occupancyLabel(project)}
        </span>
      </button>
      <div className="launcher-project-actions">
        {showsRelease(project) ? (
          <button
            type="button"
            className="launcher-project-release"
            disabled={busy}
            onClick={() => onRelease(project)}
          >
            释放占用
          </button>
        ) : null}
        <button
          type="button"
          className="launcher-project-remove"
          disabled={busy}
          aria-label={`移除 ${project.name}`}
          onClick={() => onRemove(project)}
        >
          移除
        </button>
      </div>
    </li>
  );
}

function LeaseLine({ project }: { project: DesktopProjectEntry }) {
  return (
    <span className="launcher-project-lease">
      PID {project.leasePid}
      {project.leaseCommand ? ` · ${project.leaseCommand}` : ""}
    </span>
  );
}

export function LauncherActions({
  status,
  busy,
  onChoose,
  onInitialize,
  onRetry,
}: {
  status: DesktopStatus;
  busy: boolean;
  onChoose(): void;
  onInitialize(): void;
  onRetry(): void;
}) {
  return (
    <div className="launcher-actions">
      {status.state === "needsProject" && <ChooseButton status={status} busy={busy} onChoose={onChoose} />}
      {status.state === "needsSetup" && (
        <>
          <button className="launcher-primary" onClick={onInitialize} disabled={busy}>
            <Wrench size={18} />
            初始化并打开
            <ChevronRight size={17} />
          </button>
          <button className="launcher-secondary" onClick={onChoose} disabled={busy}>
            选择其他项目
          </button>
        </>
      )}
      {(status.state === "error" || status.state === "busy") && (
        <RetryButtons status={status} busy={busy} onRetry={onRetry} onChoose={onChoose} />
      )}
      {showsAddButton(status) && <AddButton busy={busy} onChoose={onChoose} />}
      {(status.state === "starting" || status.state === "ready") && (
        <div className="launcher-busy">
          <LoaderCircle size={18} className="launcher-spinner" />
          <span>{status.message}</span>
        </div>
      )}
    </div>
  );
}

/** With a project list, adding another folder must stay reachable. */
const ADD_BUTTON_STATES = new Set<DesktopStatus["state"]>(["needsSetup", "needsProject", "ready", "starting", "error", "busy"]);

function showsAddButton(status: DesktopStatus): boolean {
  const count = status.projects?.length ?? 0;
  if (count === 0) return false;
  return !ADD_BUTTON_STATES.has(status.state);
}

function ChooseButton({
  status,
  busy,
  onChoose,
}: {
  status: DesktopStatus;
  busy: boolean;
  onChoose(): void;
}) {
  const label = (status.projects?.length ?? 0) > 0 ? "添加项目文件夹" : "选择项目文件夹";
  return (
    <button className="launcher-primary" onClick={onChoose} disabled={busy}>
      <FolderOpen size={18} />
      {label}
      <ChevronRight size={17} />
    </button>
  );
}

function AddButton({ busy, onChoose }: { busy: boolean; onChoose(): void }) {
  return (
    <button className="launcher-primary" onClick={onChoose} disabled={busy}>
      <FolderOpen size={18} />
      添加项目文件夹
      <ChevronRight size={17} />
    </button>
  );
}

function RetryButtons({
  status,
  busy,
  onRetry,
  onChoose,
}: {
  status: DesktopStatus;
  busy: boolean;
  onRetry(): void;
  onChoose(): void;
}) {
  return (
    <>
      <button className="launcher-primary" onClick={onRetry} disabled={busy}>
        <RotateCcw size={18} />
        {status.state === "busy" ? "再次检查" : "重试"}
      </button>
      <button className="launcher-secondary" onClick={onChoose} disabled={busy}>
        添加 / 选择其他项目
      </button>
    </>
  );
}

export function ChecksList({ checks }: { checks: LauncherCheck[] }) {
  return (
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
  );
}

export function TechnicalDetails({ detail }: { detail: string }) {
  return (
    <details className="launcher-details">
      <summary>技术详情</summary>
      <pre>{detail}</pre>
    </details>
  );
}

export function LauncherFooter() {
  return (
    <footer className="launcher-footer">
      <ShieldCheck size={15} />
      <span>项目与运行记录保留在本机</span>
    </footer>
  );
}
