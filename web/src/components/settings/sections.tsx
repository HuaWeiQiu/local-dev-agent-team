import { FolderCog, LoaderCircle, RefreshCw, Save, Settings2, ShieldCheck, Sparkles, Terminal } from "lucide-react";
import type { ReactNode } from "react";
import type { CliInventory, CliProbeResult, DesktopSettingsView, ProjectScope, RoleBindingInput } from "../../types";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Toggle } from "../../ui/toggle";
import { PanelHeader, SettingsSection } from "../PanelHeader";
import {
  authLabel,
  authTone,
  cacheSourceLabel,
  CLI_LABEL,
  shortPath,
  type UiState,
} from "./model";

export function SettingsHeader({
  isProject,
  projectName,
  scope,
  scanning,
  saving,
  onOpenProject,
  onOpenGlobal,
  onDetect,
  onSave,
}: {
  isProject: boolean;
  projectName: string | undefined;
  scope: ProjectScope | undefined;
  scanning: boolean;
  saving: boolean;
  onOpenProject: (() => void) | undefined;
  onOpenGlobal: (() => void) | undefined;
  onDetect: () => void;
  onSave: () => void;
}) {
  const copy = headerCopy(isProject, projectName);
  return (
    <header className="flex flex-wrap items-start gap-4">
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-ink [&_svg]:size-4">
        {isProject ? <FolderCog /> : <Settings2 />}
      </span>
      <div className="min-w-0 flex-1 basis-72">
        <span className="text-xs font-medium text-accent-ink">{copy.eyebrow}</span>
        <h1 className="m-0 mt-0.5 text-xl font-semibold tracking-tight text-ink">{copy.title}</h1>
        <p className="m-0 mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{copy.body}</p>
      </div>
      <HeaderActions
        isProject={isProject}
        scope={scope}
        scanning={scanning}
        saving={saving}
        onOpenProject={onOpenProject}
        onOpenGlobal={onOpenGlobal}
        onDetect={onDetect}
        onSave={onSave}
      />
    </header>
  );
}

interface HeaderCopy {
  eyebrow: string;
  title: string;
  body: string;
}

export function headerCopy(isProject: boolean, projectName: string | undefined): HeaderCopy {
  if (isProject) {
    return {
      eyebrow: projectName ? `当前项目 · ${projectName}` : "当前项目",
      title: "项目角色覆盖",
      body: "只改当前项目。某个角色没单独设置时，自动用全局默认；保存后新建运行和重试都会按合并结果选 CLI。",
    };
  }
  return {
    eyebrow: "本机全局",
    title: "Agent CLI 与角色默认",
    body: "检索本机 Codex / Grok / Kimi / Claude 的配置与授权状态，设置默认模型与思考深度。项目没有单独覆盖的角色会用这里的值。",
  };
}

function HeaderActions({
  isProject,
  scope,
  scanning,
  saving,
  onOpenProject,
  onOpenGlobal,
  onDetect,
  onSave,
}: {
  isProject: boolean;
  scope: ProjectScope | undefined;
  scanning: boolean;
  saving: boolean;
  onOpenProject: (() => void) | undefined;
  onOpenGlobal: (() => void) | undefined;
  onDetect: () => void;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!isProject && detectButton("手动检测", "md", scanning, saving, onDetect)}
      {isProject && onOpenGlobal && (
        <Button onClick={onOpenGlobal}>
          <Settings2 />
          <span>全局设置</span>
        </Button>
      )}
      {!isProject && onOpenProject && (
        <Button onClick={onOpenProject} disabled={!scope}>
          <FolderCog />
          <span>项目设置</span>
        </Button>
      )}
      <SaveButton isProject={isProject} saving={saving} scanning={scanning} onSave={onSave} />
    </div>
  );
}

function SaveButton({
  isProject,
  saving,
  scanning,
  onSave,
}: {
  isProject: boolean;
  saving: boolean;
  scanning: boolean;
  onSave: () => void;
}) {
  return (
    <Button variant="primary" onClick={onSave} disabled={saving || scanning}>
      {saving ? <LoaderCircle className="animate-spin" /> : <Save />}
      <span>{saving ? "保存中" : isProject ? "保存项目" : "保存全局"}</span>
    </Button>
  );
}

export function detectButton(
  label: string,
  size: "sm" | "md",
  scanning: boolean,
  saving: boolean,
  onDetect: () => void,
): ReactNode {
  return (
    <Button size={size} onClick={onDetect} disabled={scanning || saving}>
      {scanning ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
      <span>{label}</span>
    </Button>
  );
}

export function SettingsTabs({
  isProject,
  scope,
  onOpenProject,
  onOpenGlobal,
}: {
  isProject: boolean;
  scope: ProjectScope | undefined;
  onOpenProject: (() => void) | undefined;
  onOpenGlobal: (() => void) | undefined;
}) {
  const tabs = [
    { id: "global", label: "全局", active: !isProject, disabled: !isProject && !onOpenGlobal, onClick: () => onOpenGlobal?.() },
    { id: "project", label: "项目", active: isProject, disabled: !scope || (isProject && !onOpenProject), onClick: () => onOpenProject?.() },
  ] as const;
  return (
    <div className="bd-b flex items-center gap-1" role="tablist" aria-label="设置范围">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.active}
          disabled={tab.disabled}
          onClick={tab.onClick}
          className={cn(
            "-mb-px h-9 cursor-pointer border-0 border-b-2 border-transparent bg-transparent px-3 text-sm font-medium text-muted transition-colors hover:text-ink focus-ring disabled:cursor-default disabled:opacity-50",
            tab.active && "is-active border-accent text-ink",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function CliDetectSection({
  ui,
  saving,
  scanning,
  onPatchUi,
  onRescan,
}: {
  ui: UiState;
  saving: boolean;
  scanning: boolean;
  onPatchUi(patch: Partial<DesktopSettingsView["ui"]>): void;
  onRescan(): void;
}) {
  return (
    <SettingsSection>
      <PanelHeader icon={<RefreshCw />} title="CLI 配置检测" subtitle="自动检测可关；手动检测随时可用，强制扫本机配置" />
      <div className="flex flex-col divide-y divide-line">
        <Toggle
          label="自动检测"
          hint="设置页打开时每 30 秒检查配置指纹；变更则刷新模型/思考深度"
          checked={ui.autoDetectCliConfig !== false}
          onChange={(event) => onPatchUi({ autoDetectCliConfig: event.target.checked })}
          disabled={saving || scanning}
        />
        <Toggle
          label="回到窗口时检测"
          hint="切回 Agent Team 时检查 ~/.codex 等配置是否改过"
          checked={ui.autoDetectOnFocus !== false}
          onChange={(event) => onPatchUi({ autoDetectOnFocus: event.target.checked })}
          disabled={saving || scanning || ui.autoDetectCliConfig === false}
        />
        <Toggle
          label="新建运行时可选择 CLI"
          hint="关闭后新建运行直接使用项目 profile 默认，角色区只读展示当前绑定"
          checked={ui.showCliPickerInRunLauncher !== false}
          onChange={(event) => onPatchUi({ showCliPickerInRunLauncher: event.target.checked })}
          disabled={saving || scanning}
        />
        <div className="flex flex-wrap items-center justify-between gap-3 px-1 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <strong className="text-sm font-medium text-ink">手动检测</strong>
            <small className="text-xs text-muted">立即强制重扫本机 Codex / Grok / Kimi / Claude，不依赖自动开关</small>
          </div>
          <Button onClick={onRescan} disabled={scanning || saving}>
            {scanning ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
            <span>{scanning ? "检测中…" : "立即手动检测"}</span>
          </Button>
        </div>
      </div>
      <p className="m-0 text-xs text-muted">
        监听路径：~/.codex、~/.grok、~/.kimi-code、~/.claude。改完自动/手动选项后请点「保存全局」。
      </p>
    </SettingsSection>
  );
}

export function CliInventorySection({
  inventory,
  fromCache,
  cacheReason,
  scanning,
  saving,
  onRescan,
}: {
  inventory: CliInventory | undefined;
  fromCache: boolean;
  cacheReason: string | undefined;
  scanning: boolean;
  saving: boolean;
  onRescan(): void;
}) {
  return (
    <SettingsSection>
      <PanelHeader
        icon={<Terminal />}
        title="本机 CLI 清单"
        subtitle={inventorySubtitle(inventory, fromCache, cacheReason)}
        actions={detectButton("手动检测", "sm", scanning, saving, onRescan)}
      />
      <div className="bd divide-y overflow-hidden rounded-lg">
        {(inventory?.clis ?? []).map((cli) => (
          <CliRow key={cli.id} cli={cli} />
        ))}
      </div>
    </SettingsSection>
  );
}

function inventorySubtitle(
  inventory: CliInventory | undefined,
  fromCache: boolean,
  cacheReason: string | undefined,
): string {
  if (!inventory) return "尚未扫描";
  const source = cacheSourceLabel(fromCache, cacheReason);
  return `${source} · 扫描于 ${new Date(inventory.scannedAt).toLocaleString("zh-CN")}`;
}

function CliRow({ cli }: { cli: CliProbeResult }) {
  return (
    <article className={cn("flex flex-col gap-1 px-3 py-2.5", !cli.installed && "opacity-70")}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:grid sm:grid-cols-[4.5rem_6.75rem_4rem_minmax(0,1.2fr)_minmax(0,1fr)_3.5rem]">
        <strong className="text-sm font-semibold text-ink">{CLI_LABEL[cli.id]}</strong>
        <span className="justify-self-start"><Badge tone={authTone(cli.auth.status)}>{authLabel(cli.auth.status)}</Badge></span>
        <span className="text-xs text-muted">{cli.installed ? "已安装" : "未找到"}</span>
        <span className="truncate font-mono text-xs text-muted" title={cli.version}>{cli.version ?? "—"}</span>
        <span className="truncate text-xs text-muted">{cli.defaultModel ?? "—"} · {cli.defaultReasoning ?? "—"}</span>
        <span className="text-right text-xs text-muted">{cli.runtimeSupported ? "可调用" : "仅展示"}</span>
      </header>
      <CliRowDetail cli={cli} />
    </article>
  );
}

function CliRowDetail({ cli }: { cli: CliProbeResult }) {
  const detail = cli.binary ? shortPath(cli.binary) : cli.auth.detail;
  if (!detail) return null;
  return (
    <p className="m-0 truncate font-mono text-2xs text-muted" title={detail}>
      {detail}
    </p>
  );
}

export function RolesSectionHeader({
  isProject,
  adoptDisabled,
  onAdoptSuggested,
}: {
  isProject: boolean;
  adoptDisabled: boolean;
  onAdoptSuggested(): void;
}) {
  return (
    <PanelHeader
      icon={<ShieldCheck />}
      title={isProject ? "项目角色" : "全局角色默认"}
      subtitle={isProject
        ? "改过的角色只对本项目生效；点「恢复全局」后该角色重新跟全局走"
        : "保存后，没有项目覆盖的角色会用这些值；新建运行仍可在弹窗里改一次"}
      actions={!isProject && (
        <Button
          size="sm"
          onClick={onAdoptSuggested}
          disabled={adoptDisabled}
          title="按本机 CLI 检索结果填充推荐的默认模型与思考深度"
        >
          <Sparkles />
          <span>采用建议默认</span>
        </Button>
      )}
    />
  );
}

export type { RoleBindingInput };
