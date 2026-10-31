import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { errorMessage } from "../../presentation";
import type { DesktopProjectEntry, DesktopStatus } from "./types";

export interface LauncherPorts {
  setStatus(status: DesktopStatus | ((current: DesktopStatus) => DesktopStatus)): void;
  setBusy(busy: boolean): void;
}

/** Run a desktop command and fold its result (or failure) into the status. */
export async function runCommand(
  command: string,
  ports: LauncherPorts,
  args?: Record<string, unknown>,
): Promise<void> {
  ports.setBusy(true);
  try {
    ports.setStatus(await invoke<DesktopStatus>(command, args));
  } catch (error) {
    ports.setStatus({
      state: "error",
      message: "工作台暂时无法打开",
      technicalDetail: errorMessage(error),
    });
  } finally {
    ports.setBusy(false);
  }
}

/** The native folder picker, isolated so the launcher stays testable. */
export async function pickDirectory(): Promise<string | undefined> {
  const selected = await open({ directory: true, multiple: false, title: "选择代码项目" });
  return typeof selected === "string" ? selected : undefined;
}

export function confirmRelease(project: DesktopProjectEntry): boolean {
  return window.confirm(`${releaseLines(project).join("\n")}\n\n确定释放占用？`);
}

/** A run in progress needs a second, explicit confirmation before a force release. */
export function confirmForceRelease(project: DesktopProjectEntry): boolean {
  if (!(project.hasActiveRun || project.occupancy === "active-run")) return true;
  return window.confirm(
    "该项目似乎仍有进行中的任务。\n强制释放会中断 multi-agent 运行。\n\n仍要强制释放吗？",
  );
}

export function releaseLines(project: DesktopProjectEntry): string[] {
  const occupancy = project.occupancy ?? (project.busy ? "foreign" : "free");
  return [
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
}

export function confirmRemove(project: DesktopProjectEntry): boolean {
  return window.confirm(
    `项目：${project.name}\n路径：${project.path}\n\n仅从项目坞移除，不会删除磁盘上的任何文件。\n\n确定移除？`,
  );
}

export function isReleasable(project: DesktopProjectEntry): boolean {
  const occupancy = project.occupancy ?? (project.busy ? "foreign" : "free");
  return occupancy === "foreign" || occupancy === "stale" || occupancy === "active-run";
}

export function showsRelease(project: DesktopProjectEntry): boolean {
  return Boolean(project.busy) || project.occupancy === "stale";
}
