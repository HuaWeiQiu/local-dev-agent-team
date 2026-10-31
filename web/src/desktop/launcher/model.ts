import type { DesktopProjectEntry, DesktopState, DesktopStatus } from "./types";

export const initialStatus: DesktopStatus = {
  state: "starting",
  message: "正在准备工作台",
};

export interface LauncherCheck {
  label: string;
  detail: string;
  state: "done" | "active" | "waiting";
}

const OCCUPANCY_LABEL: Record<string, string> = {
  "active-run": "有任务进行中",
  foreign: "其他窗口占用",
  stale: "残留锁可清理",
  ours: "本窗口管理中",
};

export function occupancyLabel(project: DesktopProjectEntry): string {
  const known = OCCUPANCY_LABEL[occupancyKey(project)];
  if (known) return known;
  return project.hasConfig ? "可打开" : "需初始化";
}

/** Busy projects without an explicit occupancy read as another window. */
function occupancyKey(project: DesktopProjectEntry): string {
  if (project.occupancy) return project.occupancy;
  return project.busy ? "foreign" : "free";
}

export function occupancyClass(project: DesktopProjectEntry): string {
  if (project.occupancy === "active-run") return "is-active-run";
  if (project.occupancy === "stale") return "is-stale";
  if (project.occupancy === "foreign" || project.busy) return "is-busy";
  if (project.occupancy === "ours") return "is-ours";
  if (project.hasConfig) return "is-ready";
  return "is-setup";
}

export function headline(status: DesktopStatus): string {
  if (status.state === "needsProject") {
    return status.projects && status.projects.length > 0 ? "打开或添加项目" : "选择一个项目";
  }
  if (status.state === "needsSetup") return "项目需要初始化";
  if (status.state === "busy") return "项目正在运行";
  if (status.state === "error") return "没有打开成功";
  if (status.state === "ready") return "正在进入工作台";
  return "正在打开项目";
}

export function launcherChecks(status: DesktopStatus): LauncherCheck[] {
  const hasProject = Boolean(status.projectName);
  const configured = hasProject && status.state !== "needsSetup";
  const opening = status.state === "starting";
  return [
    projectCheck(status, hasProject, opening),
    configCheck(status, configured, opening, hasProject),
    workspaceCheck(status, configured, opening),
  ];
}

function projectCheck(status: DesktopStatus, hasProject: boolean, opening: boolean): LauncherCheck {
  return {
    label: "项目",
    detail: status.projectName ?? "等待选择",
    state: hasProject ? "done" : opening ? "active" : "waiting",
  };
}

function configCheck(
  status: DesktopStatus,
  configured: boolean,
  opening: boolean,
  hasProject: boolean,
): LauncherCheck {
  return {
    label: "配置",
    detail: configured ? "已识别" : status.state === "needsSetup" ? "需要初始化" : "自动检查",
    state: configured ? "done" : opening && hasProject ? "active" : "waiting",
  };
}

function workspaceCheck(
  status: DesktopStatus,
  configured: boolean,
  opening: boolean,
): LauncherCheck {
  return {
    label: "工作台",
    detail: workspaceDetail(status, opening),
    state: status.state === "ready" ? "done" : opening && configured ? "active" : "waiting",
  };
}

function workspaceDetail(status: DesktopStatus, opening: boolean): string {
  if (status.state === "ready") return "已就绪";
  if (status.state === "busy") return "由另一进程管理";
  return opening ? "正在启动" : "等待项目";
}

export function previewStatus(state: DesktopState): DesktopStatus {
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
