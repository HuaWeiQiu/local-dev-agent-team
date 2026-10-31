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

export type { DesktopProjectEntry, DesktopState, DesktopStatus };
