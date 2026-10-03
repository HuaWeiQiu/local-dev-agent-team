import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Bot,
  BookMarked,
  Check,
  ChevronsUpDown,
  FolderCog,
  FolderPlus,
  GitBranch,
  LayoutGrid,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Sun,
  Workflow,
} from "lucide-react";
import type { ComponentType } from "react";
import type { ThemeMode } from "../theme";
import { themeModeLabel } from "../theme";
import type { WorkspaceInfo } from "../types";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Kbd } from "../ui/kbd";
import { StatusDot } from "../ui/status";
import { Tooltip } from "../ui/tooltip";
import type { WorkspaceMode } from "./nav";

interface NavItem {
  mode: WorkspaceMode;
  label: string;
  ariaLabel: string;
  icon: ComponentType<{ className?: string }>;
  needsConfig?: boolean;
  needsScope?: boolean;
}

const primaryNav: NavItem[] = [
  { mode: "monitor", label: "看板", ariaLabel: "运行监控", icon: LayoutGrid },
  { mode: "design", label: "编排", ariaLabel: "策略编排", icon: Workflow, needsConfig: true },
  { mode: "evolution", label: "演进", ariaLabel: "演进工作台", icon: Sparkles, needsConfig: true },
  { mode: "experience", label: "经验", ariaLabel: "经验库", icon: BookMarked, needsConfig: true },
];

const secondaryNav: NavItem[] = [
  { mode: "project", label: "项目设置", ariaLabel: "项目设置", icon: FolderCog, needsScope: true },
  { mode: "settings", label: "全局设置", ariaLabel: "全局设置", icon: Settings2 },
];

export interface SidebarProps {
  workspace: WorkspaceInfo;
  selectedProjectId: string;
  mode: WorkspaceMode;
  hasConfig: boolean;
  hasScope: boolean;
  attentionCount: number;
  connected: boolean;
  demo: boolean;
  themeMode: ThemeMode;
  desktopShell: boolean;
  busy: boolean;
  open: boolean;
  onClose(): void;
  onNavigate(mode: WorkspaceMode): void;
  onSelectProject(projectId: string): void;
  onAddProject(): void;
  onCreate(): void;
  onCycleTheme(): void;
  onOpenPalette(): void;
}

export function Sidebar(props: SidebarProps) {
  const { workspace, selectedProjectId, mode, open } = props;
  const project = workspace.projects.find((item) => item.id === selectedProjectId);
  const ThemeIcon = props.themeMode === "light" ? Sun : props.themeMode === "dark" ? Moon : Monitor;

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-scrim md:hidden" onClick={props.onClose} aria-hidden />}
      <aside
        aria-label="主导航"
        className={cn(
          "bd-r fixed inset-y-0 left-0 z-40 flex w-[236px] shrink-0 flex-col gap-3 bg-surface px-3 pb-3 pt-3.5 transition-transform duration-200 md:static md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center gap-2.5 px-1">
          <span
            aria-hidden
            className="grid size-8 place-items-center rounded-lg text-on-accent shadow-card"
            style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
          >
            <Bot className="size-[18px]" />
          </span>
          <div className="min-w-0 leading-tight">
            <strong className="block text-base font-semibold tracking-tight text-ink">Agent Team</strong>
            <span className="text-2xs text-muted">{props.demo ? "演示数据" : "本地多智能体控制台"}</span>
          </div>
        </div>

        <ProjectSwitcher
          workspace={workspace}
          selectedProjectId={selectedProjectId}
          disabled={props.busy}
          desktopShell={props.desktopShell}
          onSelect={props.onSelectProject}
          onAdd={props.onAddProject}
        />

        <Button variant="primary" size="lg" aria-label="新建运行" title="新建运行" disabled={!props.hasConfig} onClick={props.onCreate} className="w-full justify-start gap-2 px-3">
          <Plus />
          新建运行
          <Kbd className="ml-auto border-transparent bg-on-accent/20 text-on-accent">N</Kbd>
        </Button>

        <nav className="flex flex-col gap-0.5" aria-label="工作区">
          {primaryNav.map((item) => (
            <NavButton key={item.mode} item={item} active={mode === item.mode} disabled={Boolean(item.needsConfig && !props.hasConfig)} badge={item.mode === "monitor" ? props.attentionCount : 0} onClick={() => props.onNavigate(item.mode)} />
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-0.5">
          <button
            type="button"
            onClick={props.onOpenPalette}
            className="bd mb-1 flex h-8 cursor-pointer items-center gap-2 rounded-md bg-surface-2 px-2.5 text-sm text-muted transition-colors hover:bg-surface-3 hover:text-ink focus-ring"
          >
            <Search className="size-3.5" />
            搜索与跳转
            <span className="ml-auto flex gap-0.5"><Kbd>⌘</Kbd><Kbd>K</Kbd></span>
          </button>
          {secondaryNav.map((item) => (
            <NavButton key={item.mode} item={item} active={mode === item.mode} disabled={Boolean(item.needsScope && !props.hasScope)} badge={0} onClick={() => props.onNavigate(item.mode)} />
          ))}
          <div className="bd-t mt-2 flex items-center gap-1 pt-2.5">
            <span
              className="flex min-w-0 flex-1 items-center gap-2 px-1.5 text-xs text-muted"
              title={props.connected ? "事件流已连接" : "事件流未连接"}
            >
              <StatusDot tone={props.connected ? "success" : "neutral"} pulse={props.connected} />
              <span className="truncate">{props.connected ? "实时连接" : "未连接"}</span>
              {project && (
                <span className="ml-auto flex items-center gap-1 text-2xs"><GitBranch className="size-3" />{project.defaultBranch}</span>
              )}
            </span>
            <Tooltip label={`主题：${themeModeLabel(props.themeMode)}`} side="top">
              <Button variant="ghost" size="icon-sm" onClick={props.onCycleTheme} aria-label="切换主题">
                <ThemeIcon />
              </Button>
            </Tooltip>
          </div>
        </div>
      </aside>
    </>
  );
}

function NavButton({ item, active, disabled, badge, onClick }: { item: NavItem; active: boolean; disabled: boolean; badge: number; onClick(): void }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      aria-label={item.ariaLabel}
      aria-current={active ? "page" : undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group relative flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink focus-ring disabled:pointer-events-none disabled:opacity-40",
        active && "bg-accent-soft text-accent-ink hover:bg-accent-soft hover:text-accent-ink",
      )}
    >
      {active && <span aria-hidden className="absolute -left-3 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-accent" />}
      <Icon className="size-4" />
      <span>{item.label}</span>
      {badge > 0 && (
        <span className="ml-auto grid h-4 min-w-4 place-items-center rounded-full bg-warning px-1 text-2xs font-semibold text-on-accent">{badge}</span>
      )}
    </button>
  );
}

function ProjectSwitcher({
  workspace,
  selectedProjectId,
  disabled,
  desktopShell,
  onSelect,
  onAdd,
}: {
  workspace: WorkspaceInfo;
  selectedProjectId: string;
  disabled: boolean;
  desktopShell: boolean;
  onSelect(projectId: string): void;
  onAdd(): void;
}) {
  const project = workspace.projects.find((item) => item.id === selectedProjectId);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="当前项目"
          disabled={disabled}
          className="bd flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-lg bg-surface-2 px-2.5 text-left transition-colors hover:bg-surface-3 focus-ring disabled:opacity-60"
        >
          <span aria-hidden className="grid size-6 place-items-center rounded-md bg-accent-soft text-xs font-semibold text-accent-ink">
            {(project?.name ?? "?").slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <strong className="block truncate text-sm font-semibold text-ink">{project?.name ?? "未选择项目"}</strong>
            <span className="block truncate text-2xs text-muted">{workspace.projects.length} 个项目已接入</span>
          </span>
          <ChevronsUpDown className="size-3.5 text-muted" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className="bd z-[90] min-w-[212px] rounded-lg bg-surface p-1 shadow-pop data-[state=open]:animate-[rise-in_120ms_ease-out]"
        >
          <DropdownMenu.Label className="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wider text-muted">切换项目</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={selectedProjectId} onValueChange={onSelect}>
            {workspace.projects.map((item) => (
              <DropdownMenu.RadioItem
                key={item.id}
                value={item.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink outline-none data-[highlighted]:bg-surface-3"
              >
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="text-2xs text-muted">{item.defaultBranch}</span>
                <DropdownMenu.ItemIndicator><Check className="size-3.5 text-accent" /></DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          {desktopShell ? (
            <DropdownMenu.Item
              onSelect={onAdd}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink outline-none data-[highlighted]:bg-surface-3"
            >
              <FolderPlus className="size-3.5" />添加项目
            </DropdownMenu.Item>
          ) : (
            <p className="m-0 px-2 py-1.5 text-2xs leading-relaxed text-muted">网页模式请用工作区配置接入更多项目</p>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
